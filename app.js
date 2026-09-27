const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const OpenAI = require("openai");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { passport, configurePassport } = require("./lib/passport");
const { loadConfig } = require("./lib/config");
const { pool, prisma } = require("./lib/database");
const { getSubscriptionState } = require("./lib/subscriptions");
const { MONTHLY_AMOUNT_PAISE } = require("./lib/subscriptions");
const { requireSameOrigin } = require("./lib/security");
const { requireActiveSubscription, requireAuthenticatedUser } = require("./middleware/require-active-subscription");
const { router: paymentRouter, handleRazorpayWebhook } = require("./routes/payment-routes");
const { loadLesson, renderLesson } = require("./templates/lesson-template");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const VIEW_DIR = path.join(ROOT, "views");
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function renderProtectedHtml(html, { noIndex = true } = {}) {
    const robots = noIndex ? `<meta name="robots" content="noindex, nofollow">` : "";
    const headAssets = `${robots}` +
        `<link rel="preconnect" href="https://fonts.googleapis.com">` +
        `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
        `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">` +
        `<link rel="stylesheet" href="/assets/tms-design.css">` +
        `<script src="/assets/tms-navigation.js" defer></script>`;
    const bodyAssets = `
        <footer class="tms-site-footer">
            <div class="tms-site-footer-inner">
                <div>
                    <a class="tms-brand tms-footer-brand" href="/" aria-label="TMS Academy home">
                        <span class="tms-brand-mark" aria-hidden="true">📚</span>
                        <span class="tms-brand-copy">TMS Academy<small>Learn English Through Tamil</small></span>
                    </a>
                    <p>Friendly English learning with Tamil support.</p>
                </div>
                <nav aria-label="Footer learning links">
                    <a href="/grammar.html">Grammar</a>
                    <a href="/simple-present.html">Tenses</a>
                    <a href="/sentence-making.html">Sentence Practice</a>
                    <a href="/conversation.html">Conversation</a>
                    <a href="/speaking.html">Speaking Practice</a>
                    <a href="/profile">Profile</a>
                </nav>
            </div>
            <p class="tms-footer-copyright">© ${new Date().getFullYear()} TMS Academy</p>
        </footer>
        <script src="/assets/auth-ui.js" defer></script>`;
    const withHeadAssets = html.includes("</head>")
        ? html.replace("</head>", `${headAssets}</head>`)
        : `${headAssets}${html}`;
    return withHeadAssets.includes("</body>")
        ? withHeadAssets.replace("</body>", `${bodyAssets}</body>`)
        : `${withHeadAssets}${bodyAssets}`;
}

function renderProtectedPage(filePath, options) {
    return renderProtectedHtml(fs.readFileSync(filePath, "utf8"), options);
}

function createApp() {
    const { appUrl, isProduction } = loadConfig();
    configurePassport();

    const app = express();
    app.disable("x-powered-by");
    app.set("trust proxy", 1);

    app.use((req, res, next) => {
        res.set({
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "SAMEORIGIN",
            "Referrer-Policy": "strict-origin-when-cross-origin"
        });
        next();
    });
    app.use("/assets", express.static(PUBLIC_DIR, {
        fallthrough: false,
        index: false,
        maxAge: isProduction ? "1h" : 0
    }));

    app.use(session({
        store: new pgSession({
            pool,
            tableName: "user_sessions",
            createTableIfMissing: true
        }),
        name: "tms.sid",
        secret: process.env.AUTH_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000
        }
    }));
    app.use(passport.initialize());
    app.use(passport.session());

    app.post(
        "/api/webhooks/razorpay",
        express.raw({ type: "application/json", limit: "1mb" }),
        asyncHandler(async (req, res) => {
            await handleRazorpayWebhook(
                req.body,
                req.get("x-razorpay-signature"),
                req.get("x-razorpay-event-id")
            );
            res.sendStatus(200);
        })
    );
    app.use(express.json({ limit: "32kb" }));

    app.get("/robots.txt", (req, res) => {
        res.type("text/plain").send([
            "User-agent: *",
            "Allow: /",
            "Disallow: /api/",
            "Disallow: /auth/",
            "Disallow: /login",
            "Disallow: /subscribe",
            "Disallow: /profile",
            "Disallow: /dashboard",
            "Disallow: /courses/",
            `Sitemap: ${appUrl}/sitemap.xml`
        ].join("\n"));
    });

    app.get("/sitemap.xml", (req, res) => {
        res.type("application/xml").send(
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
            `<url><loc>${appUrl}/</loc></url></urlset>`
        );
    });

    app.get("/api/public-config", (req, res) => {
        res.set("Cache-Control", "public, max-age=300");
        res.json({
            monthlyPriceRupees: MONTHLY_AMOUNT_PAISE / 100,
            currency: "INR"
        });
    });

    app.post("/api/speak", requireSameOrigin, requireActiveSubscription({ api: true }), asyncHandler(async (req, res) => {
        if (!process.env.OPENAI_API_KEY) {
            return res.status(503).json({ error: "Conversation practice is temporarily unavailable." });
        }
        const message = req.body?.message;
        const conversation = req.body?.conversation ?? [];
        if (
            typeof message !== "string" ||
            message.trim().length === 0 ||
            message.length > 2000 ||
            !Array.isArray(conversation) ||
            conversation.length > 12
        ) {
            return res.status(400).json({ error: "Please provide a message and up to 12 recent conversation turns." });
        }
        const recentConversation = conversation.map((turn) => ({
            role: typeof turn?.role === "string" ? turn.role.slice(0, 30) : "",
            content: typeof turn?.content === "string" ? turn.content.slice(0, 2000) : ""
        }));
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const response = await client.responses.create({
            model: "gpt-5-mini",
            instructions: `You are a friendly English conversation teacher for Tamil-medium students.
Have a natural conversation. Use simple English, ask a short follow-up question when appropriate,
correct important grammar mistakes, give the corrected sentence and a short Tamil explanation,
and encourage the student. Keep replies short and easy. Return only JSON with keys
"reply", "corrected", and "tamil".`,
            input: JSON.stringify({
                current_message: message.trim(),
                conversation: recentConversation
            })
        });
        let data;
        try {
            data = JSON.parse(response.output_text.replace(/```json/gi, "").replace(/```/g, "").trim());
        } catch {
            data = {
                reply: response.output_text,
                corrected: "",
                tamil: "உங்கள் English conversation தொடரலாம்."
            };
        }
        res.json({
            reply: typeof data.reply === "string" ? data.reply : "",
            corrected: typeof data.corrected === "string" ? data.corrected : "",
            tamil: typeof data.tamil === "string" ? data.tamil : ""
        });
    }));

    app.post("/api/progress/visit", requireSameOrigin, requireActiveSubscription({ api: true }), asyncHandler(async (req, res) => {
        const slug = req.body?.lessonSlug;
        if (
            typeof slug !== "string" ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(slug) ||
            slug.toLowerCase() === "index"
        ) {
            return res.status(400).json({ error: "A valid lesson is required." });
        }

        const lessonPath = path.join(ROOT, `${slug}.html`);
        if (!fs.existsSync(lessonPath) || !fs.statSync(lessonPath).isFile()) {
            return res.status(404).json({ error: "That lesson could not be found." });
        }

        const progress = await prisma.userProgress.upsert({
            where: {
                userId_lessonSlug: {
                    userId: req.user.id,
                    lessonSlug: slug
                }
            },
            create: {
                userId: req.user.id,
                lessonSlug: slug
            },
            update: {
                lastVisitedAt: new Date()
            },
            select: {
                lessonSlug: true,
                firstVisitedAt: true,
                lastVisitedAt: true
            }
        });
        res.status(200).json({ progress });
    }));

    app.get("/api/progress/recent", requireAuthenticatedUser, asyncHandler(async (req, res) => {
        const lessons = await prisma.userProgress.findMany({
            where: { userId: req.user.id },
            orderBy: { lastVisitedAt: "desc" },
            take: 5,
            select: {
                lessonSlug: true,
                firstVisitedAt: true,
                lastVisitedAt: true,
                completedAt: true
            }
        });
        res.set("Cache-Control", "no-store");
        res.json({ lessons });
    }));

    app.get("/auth/google", (req, res, next) => {
        const requestedPath = req.query.next;
        let returnTo = "/dashboard";
        if (typeof requestedPath === "string" && requestedPath.startsWith("/")) {
            try {
                const candidate = new URL(requestedPath, appUrl);
                if (candidate.origin === appUrl && !requestedPath.startsWith("//")) {
                    returnTo = `${candidate.pathname}${candidate.search}${candidate.hash}`;
                }
            } catch {
                returnTo = "/dashboard";
            }
        }
        req.session.returnTo = returnTo;
        req.session.save((error) => {
            if (error) return next(error);
            passport.authenticate("google", {
                scope: ["profile", "email"],
                prompt: "select_account"
            })(req, res, next);
        });
    });

    app.get("/auth/google/callback", (req, res, next) => {
        passport.authenticate("google", (error, user) => {
            if (error || !user) {
                if (error) console.error("Google sign-in failed:", error.message);
                return res.redirect("/login?error=google");
            }
            req.logIn(user, async (loginError) => {
                if (loginError) return next(loginError);
                try {
                    const state = await getSubscriptionState(prisma, user.id);
                    const returnTo = req.session.returnTo;
                    delete req.session.returnTo;
                    const destination = state.active
                        ? (returnTo || "/dashboard")
                        : "/subscribe";
                    req.session.save((saveError) => {
                        if (saveError) return next(saveError);
                        res.redirect(destination);
                    });
                } catch (stateError) {
                    next(stateError);
                }
            });
        })(req, res, next);
    });

    app.post("/auth/logout", requireSameOrigin, requireAuthenticatedUser, asyncHandler(async (req, res) => {
        await new Promise((resolve, reject) => {
            req.logout((error) => error ? reject(error) : resolve());
        });
        await new Promise((resolve, reject) => {
            req.session.destroy((error) => error ? reject(error) : resolve());
        });
        res.clearCookie("tms.sid", {
            httpOnly: true,
            secure: isProduction,
            sameSite: "lax"
        });
        res.sendStatus(204);
    }));

    app.get("/api/auth/me", asyncHandler(async (req, res) => {
        res.set("Cache-Control", "no-store");
        if (!req.isAuthenticated?.()) {
            return res.json({ authenticated: false });
        }
        const state = await getSubscriptionState(prisma, req.user.id);
        res.json({
            authenticated: true,
            user: {
                name: req.user.name,
                email: req.user.email,
                image: req.user.image
            },
            subscription: {
                status: state.status,
                expiryDate: state.active?.expiryDate || state.latest?.expiryDate || null
            }
        });
    }));

    app.use("/api/payments", paymentRouter);

    app.get("/login", asyncHandler(async (req, res) => {
        if (req.isAuthenticated?.()) {
            const state = await getSubscriptionState(prisma, req.user.id);
            return res.redirect(state.active ? "/dashboard" : "/subscribe");
        }
        res.sendFile(path.join(VIEW_DIR, "login.html"));
    }));

    app.get("/subscribe", requireAuthenticatedUser, (req, res) => {
        res.sendFile(path.join(VIEW_DIR, "subscribe.html"));
    });

    app.get("/dashboard", requireActiveSubscription(), (req, res, next) => {
        try {
            res.type("html").send(renderProtectedPage(path.join(ROOT, "index.html")));
        } catch (error) {
            next(error);
        }
    });

    app.get("/profile", requireAuthenticatedUser, (req, res) => {
        res.sendFile(path.join(VIEW_DIR, "profile.html"));
    });

    app.get("/", (req, res, next) => {
        try {
            res.type("html").send(renderProtectedPage(path.join(ROOT, "index.html"), { noIndex: false }));
        } catch (error) {
            next(error);
        }
    });

    app.get("/index.html", (req, res, next) => {
        try {
            res.type("html").send(renderProtectedPage(path.join(ROOT, "index.html"), { noIndex: false }));
        } catch (error) {
            next(error);
        }
    });

    app.get("/payment-success", requireActiveSubscription(), (req, res, next) => {
        if (!req.session.paymentSucceeded) {
            return res.redirect("/dashboard");
        }
        delete req.session.paymentSucceeded;
        req.session.save((error) => {
            if (error) return next(error);
            res.sendFile(path.join(VIEW_DIR, "payment-success.html"));
        });
    });

    app.get("/courses", requireActiveSubscription(), (req, res) => res.redirect("/dashboard"));
    app.get("/courses/:slug", requireActiveSubscription(), (req, res, next) => {
        const slug = req.params.slug;
        if (!/^[a-zA-Z0-9_-]+$/.test(slug)) return res.sendStatus(404);
        const lesson = loadLesson(slug);
        if (lesson) {
            return res.type("html").send(renderProtectedHtml(renderLesson(lesson, appUrl)));
        }
        const filePath = path.join(ROOT, `${slug}.html`);
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return res.redirect("/dashboard");
        }
        res.type("html").send(renderProtectedPage(filePath));
    });

    app.get(/\.html$/, (req, res, next) => {
        if (req.path.toLowerCase() === "/login.html") {
            return res.redirect("/login");
        }
        requireActiveSubscription()(req, res, (error) => {
            if (error) return next(error);
            const requestedPath = path.resolve(ROOT, `.${req.path}`);
            if (!requestedPath.startsWith(`${ROOT}${path.sep}`) || !fs.existsSync(requestedPath)) {
                return res.sendStatus(404);
            }
            try {
                const slug = path.basename(requestedPath, ".html");
                const lesson = loadLesson(slug);
                if (lesson) {
                    return res.type("html").send(renderProtectedHtml(renderLesson(lesson, appUrl)));
                }
                res.type("html").send(renderProtectedPage(requestedPath));
            } catch (readError) {
                next(readError);
            }
        });
    });

    app.use((req, res) => res.status(404).send("Page not found."));
    app.use((error, req, res, next) => {
        console.error("Request failed:", error);
        if (res.headersSent) return next(error);
        const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
        if (req.path.startsWith("/api/")) {
            return res.status(status).json({
                error: status >= 500
                    ? "Something went wrong. Please try again."
                    : error.message
            });
        }
        res.status(status).send(
            status >= 500
                ? "Something went wrong. Please try again."
                : error.message
        );
    });

    return app;
}

module.exports = { createApp };
