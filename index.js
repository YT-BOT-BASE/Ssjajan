const express = require('express');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;
let code = require('./pair'); 
const mongoose = require('mongoose');

require('events').EventEmitter.defaultMaxListeners = 500;

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://shanuka:shanuka123@cluster0.xxxxx.mongodb.net/shanuwa-db';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

app.use('/code', code);
app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/pair.html')
});
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html')
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
╭─────────────────────⭓
│   SHANUWA MINI BOT
│   Server running on port: ${PORT}
│   Owner: SHANUKA SHAMEEN
╰─────────────────────⭓
    `)
});

module.exports = app;