const mongoose = require('mongoose');

// User Schema
const userSchema = new mongoose.Schema({
    number: { type: String, required: true, unique: true },
    name: String,
    registeredAt: { type: Date, default: Date.now },
    lastSeen: Date,
    isBanned: { type: Boolean, default: false },
    banReason: String,
    totalCommands: { type: Number, default: 0 }
});

// Group Schema
const groupSchema = new mongoose.Schema({
    jid: { type: String, required: true, unique: true },
    name: String,
    joinedAt: { type: Date, default: Date.now },
    settings: {
        welcome: { type: Boolean, default: true },
        goodbye: { type: Boolean, default: true },
        antipromote: { type: Boolean, default: false },
        antidelete: { type: Boolean, default: false },
        antilink: { type: Boolean, default: false }
    }
});

// Command Stats Schema
const commandStatsSchema = new mongoose.Schema({
    command: { type: String, required: true },
    count: { type: Number, default: 0 },
    lastUsed: Date
});

// Status Schema
const statusSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    statusId: String,
    reacted: { type: Boolean, default: false },
    replied: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now }
});

// Create models
const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const CommandStats = mongoose.model('CommandStats', commandStatsSchema);
const Status = mongoose.model('Status', statusSchema);

module.exports = { User, Group, CommandStats, Status };