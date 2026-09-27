require("dotenv").config({ path: process.env.ENV_FILE || ".env.local" });

const { loadConfig } = require("./lib/config");
const { createApp } = require("./app");

const config = loadConfig();
const port = Number(process.env.PORT) || 3000;
const app = createApp();

app.listen(port, () => {
    console.log(`TMS Academy server listening at ${config.appUrl}`);
});
