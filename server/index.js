'use strict';
const { createApp } = require('./app');
const app = createApp();
const port = Number(process.env.PORT || 3000);
app.server.listen(port, () => console.log(`CampusCare running at http://localhost:${port}`));
process.on('SIGINT', () => app.close().then(() => process.exit(0)));
