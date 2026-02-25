const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os');
const { sms, downloadMediaMessage } = require("./msg");
const { User, Group, CommandStats, Status } = require('./database');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ====================
const config = {
    // Bot Info
    BOT_NAME: 'SHANUWA MINI',
    BOT_OWNER: 'SHANUKA SHAMEEN',
    OWNER_NUMBER: '94724389699',
    
    // Features
    AUTO_VIEW_STATUS: true,
    AUTO_LIKE_STATUS: true,
    AUTO_REPLY_STATUS: true,
    STATUS_REPLY_MESSAGE: 'Your Status seen By Shanuwa 🫶💗',
    AUTO_RECORDING: true,
    AUTO_LIKE_EMOJI: ['🫶', '💗', '🥺', '😘', '💕', '✨', '🌸', '🌹', '💋', '😍'],
    
    // Settings
    PREFIX: '.',
    MAX_RETRIES: 3,
    SESSION_BASE_PATH: './session',
    NUMBER_LIST_PATH: './numbers.json',
    ADMIN_LIST_PATH: './admin.json',
    
    // Images
    MAIN_IMAGE: 'https://files.catbox.moe/rzu9bu.jpg',
    WELCOME_IMAGE: 'https://files.catbox.moe/2c9ak5.jpg',
    
    // Links
    GROUP_LINK: 'https://chat.whatsapp.com/GnYQAKjoW8QD0vZL5abDk7',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCMX3K7j6fxob6STf3C',
    
    // Footer
    BOT_FOOTER: '> 𝐒𝐇𝐀𝐍𝐔𝐖𝐀 𝐌𝐈𝐍𝐈 🫶💗',
    
    // Version
    version: '2.0.0'
};

// ==================== ACTIVE SESSIONS ====================
const activeSockets = new Map();
const socketCreationTime = new Map();

// Ensure directories exist
if (!fs.existsSync(config.SESSION_BASE_PATH)) {
    fs.mkdirSync(config.SESSION_BASE_PATH, { recursive: true });
}

// ==================== UTILITY FUNCTIONS ====================

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [config.OWNER_NUMBER];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [config.OWNER_NUMBER];
    }
}

function formatMessage(title, content, footer = config.BOT_FOOTER) {
    return `╭━━━〔 *${title}* 〕━━┈⊷\n${content}\n╰──────────────┈⊷\n${footer}`;
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 2 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

function generateId(length = 6) {
    return crypto.randomBytes(length).toString('hex').slice(0, length);
}

// ==================== DATABASE FUNCTIONS ====================

async function updateUserStats(number, command = null) {
    try {
        let user = await User.findOne({ number });
        if (!user) {
            user = new User({ number });
        }
        user.lastSeen = new Date();
        if (command) {
            user.totalCommands += 1;
        }
        await user.save();
    } catch (error) {
        console.error('Error updating user stats:', error);
    }
}

async function updateCommandStats(command) {
    try {
        let cmdStat = await CommandStats.findOne({ command });
        if (!cmdStat) {
            cmdStat = new CommandStats({ command });
        }
        cmdStat.count += 1;
        cmdStat.lastUsed = new Date();
        await cmdStat.save();
    } catch (error) {
        console.error('Error updating command stats:', error);
    }
}

async function saveStatusInteraction(userId, statusId, type) {
    try {
        const status = new Status({
            userId,
            statusId,
            [type]: true
        });
        await status.save();
    } catch (error) {
        console.error('Error saving status interaction:', error);
    }
}

async function checkStatusInteraction(userId, statusId) {
    try {
        return await Status.findOne({ userId, statusId });
    } catch (error) {
        console.error('Error checking status interaction:', error);
        return null;
    }
}

// ==================== STATUS HANDLERS ====================

async function setupStatusHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast') return;

        try {
            const sender = message.key.participant;
            const statusId = message.key.id;
            
            // Update user stats
            await updateUserStats(number);
            
            // Check if already interacted
            const existing = await checkStatusInteraction(sender, statusId);
            
            // Auto recording presence
            if (config.AUTO_RECORDING) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            // Auto view status
            if (config.AUTO_VIEW_STATUS) {
                await socket.readMessages([message.key]);
            }

            // Auto like status
            if (config.AUTO_LIKE_STATUS && !existing?.reacted) {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage(
                    message.key.remoteJid,
                    { react: { text: randomEmoji, key: message.key } },
                    { statusJidList: [sender] }
                );
                await saveStatusInteraction(sender, statusId, 'reacted');
                console.log(`💗 Auto reacted to status from ${sender}`);
            }

            // Auto reply to status
            if (config.AUTO_REPLY_STATUS && !existing?.replied) {
                const replyMessage = config.STATUS_REPLY_MESSAGE.replace('{name}', message.pushName || 'friend');
                await delay(2000);
                await socket.sendMessage(sender, { 
                    text: replyMessage 
                });
                await saveStatusInteraction(sender, statusId, 'replied');
                console.log(`💬 Auto replied to status from ${sender}`);
            }

        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// ==================== COMMAND HANDLERS ====================

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? 
            msg.message.ephemeralMessage.message : msg.message;
        
        const m = sms(socket, msg);
        const sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? 
            (socket.user.id.split(':')[0] + '@s.whatsapp.net') : 
            (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const botNumber = socket.user.id.split(':')[0];
        const isOwner = config.OWNER_NUMBER.includes(senderNumber);
        const prefix = config.PREFIX;
        const body = m.body || '';
        const isCmd = body.startsWith(prefix);
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
        const args = body.trim().split(/ +/).slice(1);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const quoted = m.quoted || null;

        // Group admin check
        async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        if (!command) return;

        // Update stats
        await updateUserStats(senderNumber, command);
        await updateCommandStats(command);

        // Fake vCard for quoting
        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                    displayName: config.BOT_NAME,
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${config.BOT_NAME}\nORG:${config.BOT_OWNER};\nTEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
                
                // ==================== BASIC COMMANDS ====================
                
                case 'alive': {
                    await socket.sendMessage(sender, { react: { text: '🫶', key: msg.key } });
                    
                    const uptime = socketCreationTime.get(number) || Date.now();
                    const uptimeSeconds = Math.floor((Date.now() - uptime) / 1000);
                    const hours = Math.floor(uptimeSeconds / 3600);
                    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
                    const seconds = uptimeSeconds % 60;
                    
                    const userCount = await User.countDocuments();
                    const cmdCount = await CommandStats.countDocuments();
                    
                    const aliveText = `
┃🫶│ʙᴏᴛ: ${config.BOT_NAME}
┃🫶│ᴏᴡɴᴇʀ: ${config.BOT_OWNER}
┃🫶│ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}s
┃🫶│ᴜsᴇʀs: ${userCount}
┃🫶│ᴄᴏᴍᴍᴀɴᴅs: ${cmdCount}
┃🫶│ᴍᴇᴍᴏʀʏ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
┃🫶│ᴛɪᴍᴇ: ${getSriLankaTimestamp()}
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.MAIN_IMAGE },
                        caption: formatMessage('🫶 ɪ'ᴍ ᴀʟɪᴠᴇ', aliveText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'menu':
                case 'help': {
                    await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
                    
                    const menuText = `
┃🫶│ᴜsᴇʀ: @${sender.split('@')[0]}
┃🫶│ᴘʀᴇғɪx: ${prefix}
┃🫶│ᴛɪᴍᴇ: ${getSriLankaTimestamp()}

*📋 ᴍᴇɴᴜ ᴄᴀᴛᴇɢᴏʀɪᴇs:*

╭───────────────⭓
│ 𝟭. ɢᴇɴᴇʀᴀʟ
│ 𝟮. sᴛᴀᴛᴜs
│ 𝟯. ᴄᴏɴᴛᴀᴄᴛ
│ 𝟰. sʏsᴛᴇᴍ
│ 𝟱. ᴅᴏᴡɴʟᴏᴀᴅ
│ 𝟲. ɢʀᴏᴜᴘ
│ 𝟳. ғᴜɴ
╰───────────────⭓

ᴛʏᴘᴇ *.menu [ᴄᴀᴛᴇɢᴏʀʏ]* ғᴏʀ ᴅᴇᴛᴀɪʟs
ᴇx: .menu ɢᴇɴᴇʀᴀʟ
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.MAIN_IMAGE },
                        caption: formatMessage('🫶 sʜᴀɴᴜᴡᴀ ᴍᴇɴᴜ', menuText),
                        mentions: [sender]
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'menu general': {
                    const generalMenu = `
┃🎯│.alive - ᴄʜᴇᴄᴋ ʙᴏᴛ sᴛᴀᴛᴜs
┃🎯│.menu - sʜᴏᴡ ᴍᴀɪɴ ᴍᴇɴᴜ
┃🎯│.ping - ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴsᴇ sᴘᴇᴇᴅ
┃🎯│.owner - ᴄᴏɴᴛᴀᴄᴛ ᴏᴡɴᴇʀ
┃🎯│.botinfo - ʙᴏᴛ ɪɴғᴏʀᴍᴀᴛɪᴏɴ
┃🎯│.stats - ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('🎯 ɢᴇɴᴇʀᴀʟ ᴄᴏᴍᴍᴀɴᴅs', generalMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu status': {
                    const statusMenu = `
┃📱│.viewstatus - ᴠɪᴇᴅ sᴛᴀᴛᴜs sᴇᴛᴛɪɴɢs
┃📱│.reactstatus - sᴇᴛ ᴀᴜᴛᴏ ʀᴇᴀᴄᴛ
┃📱│.replystatus - sᴇᴛ ᴀᴜᴛᴏ ʀᴇᴘʟʏ
┃📱│.statusmsg <ᴛᴇxᴛ> - ᴄʜᴀɴɢᴇ sᴛᴀᴛᴜs ʀᴇᴘʟʏ
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('📱 sᴛᴀᴛᴜs ᴄᴏᴍᴍᴀɴᴅs', statusMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu contact': {
                    const contactMenu = `
┃📞│.owner - ᴏᴡɴᴇʀ ᴄᴏɴᴛᴀᴄᴛ
┃📞│.group - ɢʀᴏᴜᴘ ʟɪɴᴋ
┃📞│.channel - ᴄʜᴀɴɴᴇʟ ʟɪɴᴋ
┃📞│.contact @ᴜsᴇʀ - ɢᴇᴛ ᴄᴏɴᴛᴀᴄᴛ
┃📞│.save - sᴀᴠᴇ ᴄᴏɴᴛᴀᴄᴛ
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('📞 ᴄᴏɴᴛᴀᴄᴛ ᴄᴏᴍᴍᴀɴᴅs', contactMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu system': {
                    const systemMenu = `
┃⚙️│.system - sʏsᴛᴇᴍ ɪɴғᴏ
┃⚙️│.stats - ʙᴏᴛ sᴛᴀᴛs
┃⚙️│.uptime - ʙᴏᴛ ᴜᴘᴛɪᴍᴇ
┃⚙️│.restart - ʀᴇsᴛᴀʀᴛ ʙᴏᴛ (ᴏᴡɴᴇʀ)
┃⚙️│.shutdown - sʜᴜᴛᴅᴏᴡɴ (ᴏᴡɴᴇʀ)
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('⚙️ sʏsᴛᴇᴍ ᴄᴏᴍᴍᴀɴᴅs', systemMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu download': {
                    const downloadMenu = `
┃📥│.song <ɴᴀᴍᴇ> - ᴅᴏᴡɴʟᴏᴀᴅ sᴏɴɢ
┃📥│.video <ɴᴀᴍᴇ> - ᴅᴏᴡɴʟᴏᴀᴅ ᴠɪᴅᴇᴏ
┃📥│.yt <ʟɪɴᴋ> - ʏᴏᴜᴛᴜʙᴇ ᴅʟ
┃📥│.fb <ʟɪɴᴋ> - ғᴀᴄᴇʙᴏᴏᴋ ᴅʟ
┃📥│.ig <ʟɪɴᴋ> - ɪɴsᴛᴀɢʀᴀᴍ ᴅʟ
┃📥│.tt <ʟɪɴᴋ> - ᴛɪᴋᴛᴏᴋ ᴅʟ
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('📥 ᴅᴏᴡɴʟᴏᴀᴅ ᴄᴏᴍᴍᴀɴᴅs', downloadMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu group': {
                    const groupMenu = `
┃👥│.add <ɴᴜᴍʙᴇʀ> - ᴀᴅᴅ ᴍᴇᴍʙᴇʀ
┃👥│.kick @ᴜsᴇʀ - ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀ
┃👥│.promote @ᴜsᴇʀ - ᴘʀᴏᴍᴏᴛᴇ ᴀᴅᴍɪɴ
┃👥│.demote @ᴜsᴇʀ - ᴅᴇᴍᴏᴛᴇ ᴀᴅᴍɪɴ
┃👥│.tagall - ᴛᴀɢ ᴀʟʟ ᴍᴇᴍʙᴇʀs
┃👥│.link - ɢʀᴏᴜᴘ ʟɪɴᴋ
┃👥│.close - ᴄʟᴏsᴇ ɢʀᴏᴜᴘ
┃👥│.open - ᴏᴘᴇɴ ɢʀᴏᴜᴘ
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('👥 ɢʀᴏᴜᴘ ᴄᴏᴍᴍᴀɴᴅs', groupMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                case 'menu fun': {
                    const funMenu = `
┃🎭│.joke - ʀᴀɴᴅᴏᴍ ᴊᴏᴋᴇ
┃🎭│.quote - ʀᴀɴᴅᴏᴍ ǫᴜᴏᴛᴇ
┃🎭│.fact - ʀᴀɴᴅᴏᴍ ғᴀᴄᴛ
┃🎭│.roast - ʀᴀɴᴅᴏᴍ ʀᴏᴀsᴛ
┃🎭│.love - ʟᴏᴠᴇ ᴍᴇssᴀɢᴇ
┃🎭│.shayari - ʜɪɴᴅɪ sʜᴀʏᴀʀɪ
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('🎭 ғᴜɴ ᴄᴏᴍᴍᴀɴᴅs', funMenu)
                    }, { quoted: fakevCard });
                    break;
                }

                // ==================== CONTACT COMMANDS ====================

                case 'owner': {
                    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
                    
                    const vcard = 'BEGIN:VCARD\n' +
                        'VERSION:3.0\n' +
                        'FN:' + config.BOT_OWNER + '\n' +
                        'ORG:Bot Owner;\n' +
                        'TEL;type=CELL;type=VOICE;waid=' + config.OWNER_NUMBER + ':+' + config.OWNER_NUMBER + '\n' +
                        'END:VCARD';

                    await socket.sendMessage(sender, {
                        contacts: {
                            displayName: config.BOT_OWNER,
                            contacts: [{ vcard }]
                        }
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('👑 ᴏᴡɴᴇʀ', 
                            `ɴᴀᴍᴇ: ${config.BOT_OWNER}\nɴᴜᴍʙᴇʀ: ${config.OWNER_NUMBER}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'group': {
                    await socket.sendMessage(sender, { react: { text: '👥', key: msg.key } });
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('👥 ᴡʜᴀᴛsᴀᴘᴘ ɢʀᴏᴜᴘ',
                            `ᴊᴏɪɴ ᴏᴜʀ ɢʀᴏᴜᴘ:\n${config.GROUP_LINK}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'channel': {
                    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('📢 ᴡʜᴀᴛsᴀᴘᴘ ᴄʜᴀɴɴᴇʟ',
                            `ғᴏʟʟᴏᴡ ᴏᴜʀ ᴄʜᴀɴɴᴇʟ:\n${config.CHANNEL_LINK}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'contact': {
                    await socket.sendMessage(sender, { react: { text: '📇', key: msg.key } });
                    
                    let target = sender;
                    if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                        target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                    } else if (quoted) {
                        target = quoted.sender;
                    } else if (args[0]) {
                        target = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    }

                    try {
                        const [userInfo] = await socket.onWhatsApp(target);
                        if (!userInfo?.exists) {
                            await socket.sendMessage(sender, {
                                text: '❌ ᴜsᴇʀ ɴᴏᴛ ғᴏᴜɴᴅ'
                            }, { quoted: fakevCard });
                            break;
                        }

                        let ppUrl;
                        try {
                            ppUrl = await socket.profilePictureUrl(target, 'image');
                        } catch {
                            ppUrl = config.MAIN_IMAGE;
                        }

                        let name = target.split('@')[0];
                        try {
                            const presence = await socket.presenceSubscribe(target);
                            if (presence?.pushName) name = presence.pushName;
                        } catch {}

                        const contactText = `
┃📇│ɴᴀᴍᴇ: ${name}
┃📇│ɴᴜᴍʙᴇʀ: ${target.split('@')[0]}
┃📇│ᴊɪᴅ: ${target}
`;

                        await socket.sendMessage(sender, {
                            image: { url: ppUrl },
                            caption: formatMessage('📇 ᴄᴏɴᴛᴀᴄᴛ ɪɴғᴏ', contactText),
                            mentions: [target]
                        }, { quoted: fakevCard });

                    } catch (error) {
                        console.error('Contact error:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ᴄᴏɴᴛᴀᴄᴛ ɪɴғᴏ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== STATUS COMMANDS ====================

                case 'viewstatus': {
                    await socket.sendMessage(sender, { react: { text: '👁️', key: msg.key } });
                    
                    const statusText = `
┃👁️│ᴀᴜᴛᴏ ᴠɪᴇᴡ: ${config.AUTO_VIEW_STATUS ? 'ᴏɴ' : 'ᴏғғ'}
┃👁️│ᴀᴜᴛᴏ ʟɪᴋᴇ: ${config.AUTO_LIKE_STATUS ? 'ᴏɴ' : 'ᴏғғ'}
┃👁️│ᴀᴜᴛᴏ ʀᴇᴘʟʏ: ${config.AUTO_REPLY_STATUS ? 'ᴏɴ' : 'ᴏғғ'}
┃👁️│ʀᴇᴘʟʏ ᴍsɢ: ${config.STATUS_REPLY_MESSAGE}
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('👁️ sᴛᴀᴛᴜs sᴇᴛᴛɪɴɢs', statusText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'reactstatus': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    config.AUTO_LIKE_STATUS = !config.AUTO_LIKE_STATUS;
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('✅ ᴜᴘᴅᴀᴛᴇᴅ',
                            `ᴀᴜᴛᴏ ʟɪᴋᴇ ɪs ɴᴏᴡ: ${config.AUTO_LIKE_STATUS ? 'ᴏɴ' : 'ᴏғғ'}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'replystatus': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    config.AUTO_REPLY_STATUS = !config.AUTO_REPLY_STATUS;
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('✅ ᴜᴘᴅᴀᴛᴇᴅ',
                            `ᴀᴜᴛᴏ ʀᴇᴘʟʏ ɪs ɴᴏᴡ: ${config.AUTO_REPLY_STATUS ? 'ᴏɴ' : 'ᴏғғ'}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'statusmsg': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .statusmsg <ʏᴏᴜʀ ᴍᴇssᴀɢᴇ>'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    const newMessage = args.join(' ');
                    config.STATUS_REPLY_MESSAGE = newMessage;
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('✅ ᴜᴘᴅᴀᴛᴇᴅ',
                            `sᴛᴀᴛᴜs ʀᴇᴘʟʏ ᴜᴘᴅᴀᴛᴇᴅ ᴛᴏ:\n"${newMessage}"`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== SYSTEM COMMANDS ====================

                case 'system':
                case 'sys': {
                    await socket.sendMessage(sender, { react: { text: '⚙️', key: msg.key } });
                    
                    const uptime = process.uptime();
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);
                    
                    const totalMem = os.totalmem() / 1024 / 1024 / 1024;
                    const freeMem = os.freemem() / 1024 / 1024 / 1024;
                    const usedMem = totalMem - freeMem;
                    
                    const systemText = `
┃⚙️│ᴏs: ${os.type()} ${os.release()}
┃⚙️│ʜᴏsᴛ: ${os.hostname()}
┃⚙️│ᴄᴘᴜ: ${os.cpus()[0].model}
┃⚙️│ᴄᴏʀᴇs: ${os.cpus().length}
┃⚙️│ʀᴀᴍ: ${usedMem.toFixed(2)}GB / ${totalMem.toFixed(2)}GB
┃⚙️│ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
┃⚙️│ɴᴏᴅᴇ: ${process.version}
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('⚙️ sʏsᴛᴇᴍ ɪɴғᴏ', systemText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'stats': {
                    await socket.sendMessage(sender, { react: { text: '📊', key: msg.key } });
                    
                    const userCount = await User.countDocuments();
                    const groupCount = await Group.countDocuments();
                    const cmdStats = await CommandStats.find().sort({ count: -1 }).limit(5);
                    
                    let topCommands = '';
                    cmdStats.forEach((cmd, i) => {
                        topCommands += `┃📊│${i+1}. ${cmd.command}: ${cmd.count} ᴜsᴇs\n`;
                    });
                    
                    const statsText = `
┃📊│ᴜsᴇʀs: ${userCount}
┃📊│ɢʀᴏᴜᴘs: ${groupCount}
┃📊│ᴀᴄᴛɪᴠᴇ: ${activeSockets.size}
${topCommands}
┃📊│ᴛᴏᴛᴀʟ ᴄᴍᴅs: ${await CommandStats.countDocuments()}
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.MAIN_IMAGE },
                        caption: formatMessage('📊 ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs', statsText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'ping': {
                    const start = Date.now();
                    await socket.sendMessage(sender, { react: { text: '🏓', key: msg.key } });
                    
                    await socket.sendMessage(sender, { 
                        text: 'ᴘɪɴɢ...' 
                    }, { quoted: msg });
                    
                    const end = Date.now();
                    const latency = end - start;
                    
                    let emoji = '🟢';
                    if (latency > 300) emoji = '🟡';
                    if (latency > 600) emoji = '🔴';
                    
                    const pingText = `
┃🏓│ʟᴀᴛᴇɴᴄʏ: ${latency}ms
┃🏓│sᴛᴀᴛᴜs: ${emoji} ${latency < 300 ? 'ɢᴏᴏᴅ' : latency < 600 ? 'ᴍᴇᴅɪᴜᴍ' : 'sʟᴏᴡ'}
┃🏓│ᴛɪᴍᴇ: ${getSriLankaTimestamp()}
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('🏓 ᴘᴏɴɢ', pingText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'uptime': {
                    await socket.sendMessage(sender, { react: { text: '⏰', key: msg.key } });
                    
                    const uptime = socketCreationTime.get(number) || Date.now();
                    const uptimeSeconds = Math.floor((Date.now() - uptime) / 1000);
                    const days = Math.floor(uptimeSeconds / 86400);
                    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
                    const minutes = Math.floor((uptimeSeconds % 3600) / 60);
                    const seconds = uptimeSeconds % 60;
                    
                    const uptimeText = `
┃⏰│ᴅᴀʏs: ${days}
┃⏰│ʜᴏᴜʀs: ${hours}
┃⏰│ᴍɪɴᴜᴛᴇs: ${minutes}
┃⏰│sᴇᴄᴏɴᴅs: ${seconds}
┃⏰│ᴛᴏᴛᴀʟ: ${uptimeSeconds}s
`;

                    await socket.sendMessage(sender, {
                        text: formatMessage('⏰ ʙᴏᴛ ᴜᴘᴛɪᴍᴇ', uptimeText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'botinfo':
                case 'info': {
                    await socket.sendMessage(sender, { react: { text: 'ℹ️', key: msg.key } });
                    
                    const infoText = `
┃ℹ️│ɴᴀᴍᴇ: ${config.BOT_NAME}
┃ℹ️│ᴏᴡɴᴇʀ: ${config.BOT_OWNER}
┃ℹ️│ᴠᴇʀsɪᴏɴ: ${config.version}
┃ℹ️│ᴘʀᴇғɪx: ${prefix}
┃ℹ️│ʟᴀɴɢᴜᴀɢᴇ: JavaScript
┃ℹ️│ʟɪʙʀᴀʀʏ: Baileys
┃ℹ️│ᴘʟᴀᴛғᴏʀᴍ: ${os.platform()}
`;

                    await socket.sendMessage(sender, {
                        image: { url: config.MAIN_IMAGE },
                        caption: formatMessage('ℹ️ ʙᴏᴛ ɪɴғᴏʀᴍᴀᴛɪᴏɴ', infoText)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== FUN COMMANDS ====================

                case 'joke': {
                    await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
                    
                    try {
                        const jokes = [
                            "Why don't scientists trust atoms? Because they make up everything! 😂",
                            "What do you call a fake noodle? An impasta! 🍝",
                            "Why did the scarecrow win an award? Because he was outstanding in his field! 🌾",
                            "What do you call a bear with no teeth? A gummy bear! 🐻",
                            "Why don't eggs tell jokes? They'd crack each other up! 🥚",
                            "What do you call a sleeping bull? A bulldozer! 🐂",
                            "Why did the math book look sad? Because it had too many problems! 📚",
                            "What do you call a fish wearing a bowtie? Sofishticated! 🐠",
                            "Why don't skeletons fight each other? They don't have the guts! 💀",
                            "What do you call a factory that makes okay products? A satisfactory! 🏭"
                        ];
                        
                        const randomJoke = jokes[Math.floor(Math.random() * jokes.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('😂 ʀᴀɴᴅᴏᴍ ᴊᴏᴋᴇ', randomJoke)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ᴊᴏᴋᴇ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'quote': {
                    await socket.sendMessage(sender, { react: { text: '💭', key: msg.key } });
                    
                    try {
                        const quotes = [
                            "The best way to predict the future is to create it. - Peter Drucker",
                            "Life is what happens when you're busy making other plans. - John Lennon",
                            "The only way to do great work is to love what you do. - Steve Jobs",
                            "Believe you can and you're halfway there. - Theodore Roosevelt",
                            "It does not matter how slowly you go as long as you do not stop. - Confucius",
                            "Everything you've ever wanted is on the other side of fear. - Unknown",
                            "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
                            "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",
                            "What you get by achieving your goals is not as important as what you become by achieving your goals. - Zig Ziglar",
                            "The only limit to our realization of tomorrow will be our doubts of today. - Franklin D. Roosevelt"
                        ];
                        
                        const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('💭 ʀᴀɴᴅᴏᴍ ǫᴜᴏᴛᴇ', randomQuote)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ǫᴜᴏᴛᴇ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'fact': {
                    await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
                    
                    try {
                        const facts = [
                            "Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs, still edible! 🍯",
                            "A day on Venus is longer than a year on Venus. 🌍",
                            "Octopuses have three hearts and blue blood! 🐙",
                            "Bananas are technically berries, but strawberries aren't. 🍌",
                            "Wombat poop is cube-shaped to prevent it from rolling away. 💩",
                            "The Eiffel Tower can be 15 cm taller during the summer due to thermal expansion. 🗼",
                            "There are more stars in the universe than grains of sand on Earth. ✨",
                            "A group of flamingos is called a 'flamboyance'. 🦩",
                            "The shortest war in history was between Britain and Zanzibar in 1896. It lasted 38 minutes. ⚔️",
                            "Cows have best friends and get stressed when separated from them. 🐮"
                        ];
                        
                        const randomFact = facts[Math.floor(Math.random() * facts.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('🔍 ʀᴀɴᴅᴏᴍ ғᴀᴄᴛ', randomFact)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ғᴀᴄᴛ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'roast': {
                    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
                    
                    try {
                        const roasts = [
                            "You're not stupid; you just have bad luck thinking. 🔥",
                            "I'd agree with you, but then we'd both be wrong. 🔥",
                            "You bring everyone so much joy! When you leave, I mean. 🔥",
                            "I'd explain it to you, but I left my crayons at home. 🔥",
                            "If I wanted to hear from an idiot, I'd watch your TikToks. 🔥",
                            "You're the reason the gene pool needs a lifeguard. 🔥",
                            "Somewhere, a village is missing its idiot. 🔥",
                            "You're not a complete idiot, some parts are missing. 🔥",
                            "I'd tell you to go outside, but the WiFi doesn't reach there. 🔥",
                            "You have the right to remain silent because whatever you say will probably be stupid anyway. 🔥"
                        ];
                        
                        const randomRoast = roasts[Math.floor(Math.random() * roasts.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('🔥 ʀᴀɴᴅᴏᴍ ʀᴏᴀsᴛ', randomRoast)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ʀᴏᴀsᴛ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'love': {
                    await socket.sendMessage(sender, { react: { text: '💗', key: msg.key } });
                    
                    try {
                        const loveMessages = [
                            "You're the piece of me I wish I didn't need. 💗",
                            "I love you like a fat kid loves cake. 🎂",
                            "If you were a vegetable, you'd be a 'cute-cumber'. 🥒",
                            "Are you a magician? Because whenever I look at you, everyone else disappears. ✨",
                            "Do you have a map? I keep getting lost in your eyes. 🗺️",
                            "Is your name Google? Because you have everything I'm searching for. 🔍",
                            "Are you made of copper and tellurium? Because you're Cu-Te. 💕",
                            "If you were a fruit, you'd be a 'fine-apple'. 🍍",
                            "Do you have a Band-Aid? Because I just scraped my knee falling for you. 🩹",
                            "Are you a parking ticket? Because you've got FINE written all over you. 🎫"
                        ];
                        
                        const randomLove = loveMessages[Math.floor(Math.random() * loveMessages.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('💗 ʟᴏᴠᴇ ᴍᴇssᴀɢᴇ', randomLove)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ʟᴏᴠᴇ ᴍᴇssᴀɢᴇ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'shayari': {
                    await socket.sendMessage(sender, { react: { text: '📝', key: msg.key } });
                    
                    try {
                        const shayaris = [
                            "तेरी यादों में खोए रहते हैं,\nतेरे ख्वाबों में सोए रहते हैं।\nतू तो है नहीं यहाँ,\nफिर भी तेरे ही होए रहते हैं। 💕",
                            "दिल की बात लबों पर लाना होगा,\nआज उनसे मिलने का बहाना होगा।\nशायद वो न समझे हमारी बात,\nफिर भी हमें उन्हें समझाना होगा। ✨",
                            "हम तुम्हारे लिए ही तो जीते हैं,\nहर खुशी हर गम में हंसते हैं।\nतुम खुश रहो यही दुआ है हमारी,\nतुम्हारे लिए हर दर्द सहते हैं। 💫",
                            "मोहब्बत में ऐसा मंजर देखा नहीं,\nकिसी को तरसते हुए इस कदर देखा नहीं।\nतड़पता है दिल मिलने को तुमसे,\nलेकिन तुमने कभी इस दिल को देखा नहीं। 🌹",
                            "वो मुझसे रूठे तो मैं मान गया,\nबात दिल की उनसे कह न सका।\nसोचा था उन्हें अपना बना लूंगा,\nलेकिन हालातों से जीत न सका। 💔"
                        ];
                        
                        const randomShayari = shayaris[Math.floor(Math.random() * shayaris.length)];
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('📝 sʜᴀʏᴀʀɪ', randomShayari)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ sʜᴀʏᴀʀɪ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== GROUP COMMANDS ====================

                case 'add': {
                    await socket.sendMessage(sender, { react: { text: '➕', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴀᴅᴅ ᴍᴇᴍʙᴇʀs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .add 9472xxxxxx'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('✅ ᴍᴇᴍʙᴇʀ ᴀᴅᴅᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴀᴅᴅᴇᴅ @${numberToAdd.split('@')[0]}`),
                            mentions: [numberToAdd]
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴀᴅᴅ ᴍᴇᴍʙᴇʀ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'kick': {
                    await socket.sendMessage(sender, { react: { text: '👢', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    let targetUser;
                    if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                        targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                    } else if (quoted) {
                        targetUser = quoted.sender;
                    } else if (args[0]) {
                        targetUser = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    } else {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .kick @ᴜsᴇʀ ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴜsᴇʀ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        await socket.groupParticipantsUpdate(from, [targetUser], 'remove');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('👢 ᴍᴇᴍʙᴇʀ ᴋɪᴄᴋᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ @${targetUser.split('@')[0]}`),
                            mentions: [targetUser]
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'promote': {
                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    let targetUser;
                    if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                        targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                    } else if (quoted) {
                        targetUser = quoted.sender;
                    } else if (args[0]) {
                        targetUser = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    } else {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .promote @ᴜsᴇʀ ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴜsᴇʀ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        await socket.groupParticipantsUpdate(from, [targetUser], 'promote');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('⬆️ ᴍᴇᴍʙᴇʀ ᴘʀᴏᴍᴏᴛᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴍᴏᴛᴇᴅ @${targetUser.split('@')[0]} ᴛᴏ ᴀᴅᴍɪɴ`),
                            mentions: [targetUser]
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'demote': {
                    await socket.sendMessage(sender, { react: { text: '⬇️', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴅᴇᴍᴏᴛᴇ ᴀᴅᴍɪɴs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    let targetUser;
                    if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
                        targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                    } else if (quoted) {
                        targetUser = quoted.sender;
                    } else if (args[0]) {
                        targetUser = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                    } else {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .demote @ᴜsᴇʀ ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴜsᴇʀ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        await socket.groupParticipantsUpdate(from, [targetUser], 'demote');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('⬇️ ᴀᴅᴍɪɴ ᴅᴇᴍᴏᴛᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇᴍᴏᴛᴇᴅ @${targetUser.split('@')[0]} ғʀᴏᴍ ᴀᴅᴍɪɴ`),
                            mentions: [targetUser]
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴇᴍᴏᴛᴇ ᴀᴅᴍɪɴ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'tagall': {
                    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴜsᴇ ᴛᴀɢᴀʟʟ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        const groupMetadata = await socket.groupMetadata(from);
                        const participants = groupMetadata.participants;
                        
                        let mentionsText = '';
                        participants.forEach(p => {
                            mentionsText += `@${p.id.split('@')[0]}\n`;
                        });
                        
                        const message = args.join(' ') || 'ɴᴏ ᴍᴇssᴀɢᴇ';
                        
                        await socket.sendMessage(from, {
                            text: formatMessage('📢 ᴛᴀɢᴀʟʟ',
                                `ᴍᴇssᴀɢᴇ: ${message}\n\n${mentionsText}`),
                            mentions: participants.map(p => p.id)
                        }, { quoted: msg });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴛᴀɢ ᴀʟʟ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'link': {
                    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        const inviteCode = await socket.groupInviteCode(from);
                        const groupLink = `https://chat.whatsapp.com/${inviteCode}`;
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('🔗 ɢʀᴏᴜᴘ ʟɪɴᴋ', groupLink)
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'close': {
                    await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴄʟᴏsᴇ ɢʀᴏᴜᴘ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        await socket.groupSettingUpdate(from, 'announcement');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('🔒 ɢʀᴏᴜᴘ ᴄʟᴏsᴇᴅ',
                                'ɢʀᴏᴜᴘ ʜᴀs ʙᴇᴇɴ ᴄʟᴏsᴇᴅ. ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs.')
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴄʟᴏsᴇ ɢʀᴏᴜᴘ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                case 'open': {
                    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
                    
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ ᴏᴘᴇɴ ɢʀᴏᴜᴘ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    try {
                        await socket.groupSettingUpdate(from, 'not_announcement');
                        
                        await socket.sendMessage(sender, {
                            text: formatMessage('🔓 ɢʀᴏᴜᴘ ᴏᴘᴇɴᴇᴅ',
                                'ɢʀᴏᴜᴘ ʜᴀs ʙᴇᴇɴ ᴏᴘᴇɴᴇᴅ. ᴀʟʟ ᴍᴇᴍʙᴇʀs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs.')
                        }, { quoted: fakevCard });
                        
                    } catch (error) {
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ ᴏᴘᴇɴ ɢʀᴏᴜᴘ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== OWNER COMMANDS ====================

                case 'restart': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('🔄 ʀᴇsᴛᴀʀᴛɪɴɢ',
                            'ʙᴏᴛ ɪs ʀᴇsᴛᴀʀᴛɪɴɢ...\nᴘʟᴇᴀsᴇ ᴡᴀɪᴛ ғᴇᴡ sᴇᴄᴏɴᴅs.')
                    }, { quoted: fakevCard });
                    
                    await delay(2000);
                    process.exit(0);
                    break;
                }

                case 'shutdown': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('🛑 sʜᴜᴛᴛɪɴɢ ᴅᴏᴡɴ',
                            'ʙᴏᴛ ɪs sʜᴜᴛᴛɪɴɢ ᴅᴏᴡɴ...\ɢᴏᴏᴅʙʏᴇ! 👋')
                    }, { quoted: fakevCard });
                    
                    await delay(2000);
                    process.exit(0);
                    break;
                }

                case 'bc':
                case 'broadcast': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ ᴏᴡɴᴇʀ ᴏɴʟʏ ᴄᴏᴍᴍᴀɴᴅ'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .bc <ᴍᴇssᴀɢᴇ>'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    const bcMessage = args.join(' ');
                    
                    // Get all chats
                    const chats = Object.values(socket.chats || {});
                    const groups = chats.filter(c => c.id.endsWith('@g.us'));
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('📢 ʙʀᴏᴀᴅᴄᴀsᴛ',
                            `ʙʀᴏᴀᴅᴄᴀsᴛɪɴɢ ᴛᴏ ${groups.length} ɢʀᴏᴜᴘs...`)
                    }, { quoted: fakevCard });
                    
                    let success = 0;
                    let failed = 0;
                    
                    for (const group of groups) {
                        try {
                            await socket.sendMessage(group.id, {
                                text: formatMessage('📢 ʙʀᴏᴀᴅᴄᴀsᴛ ᴍᴇssᴀɢᴇ',
                                    bcMessage,
                                    `> ${config.BOT_NAME} 🫶💗`)
                            });
                            success++;
                            await delay(500);
                        } catch (error) {
                            failed++;
                        }
                    }
                    
                    await socket.sendMessage(sender, {
                        text: formatMessage('✅ ʙʀᴏᴀᴅᴄᴀsᴛ ᴄᴏᴍᴘʟᴇᴛᴇ',
                            `sᴜᴄᴄᴇss: ${success}\nғᴀɪʟᴇᴅ: ${failed}`)
                    }, { quoted: fakevCard });
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== DOWNLOAD COMMANDS ====================

                case 'song':
                case 'play': {
                    await socket.sendMessage(sender, { react: { text: '🎵', key: msg.key } });
                    
                    const query = args.join(' ');
                    if (!query) {
                        await socket.sendMessage(sender, {
                            text: '📌 ᴜsᴀɢᴇ: .song <sᴏɴɢ ɴᴀᴍᴇ>'
                        }, { quoted: fakevCard });
                        break;
                    }
                    
                    await socket.sendMessage(sender, {
                        text: '🔍 sᴇᴀʀᴄʜɪɴɢ sᴏɴɢ... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.'
                    }, { quoted: fakevCard });
                    
                    try {
                        const yts = require('yt-search');
                        const search = await yts(query);
                        
                        if (!search.videos || search.videos.length === 0) {
                            await socket.sendMessage(sender, {
                                text: '❌ ɴᴏ sᴏɴɢs ғᴏᴜɴᴅ'
                            }, { quoted: fakevCard });
                            break;
                        }
                        
                        const video = search.videos[0];
                        
                        const infoText = `
┃🎵│ᴛɪᴛʟᴇ: ${video.title}
┃🎵│ᴅᴜʀᴀᴛɪᴏɴ: ${video.timestamp}
┃🎵│ᴠɪᴇᴡs: ${video.views.toLocaleString()}
┃🎵│ᴜᴘʟᴏᴀᴅᴇᴅ: ${video.ago}
┃🎵│ᴀᴜᴛʜᴏʀ: ${video.author.name}
`;

                        await socket.sendMessage(sender, {
                            image: { url: video.thumbnail },
                            caption: formatMessage('🎵 sᴏɴɢ ғᴏᴜɴᴅ', infoText)
                        }, { quoted: fakevCard });
                        
                        // Note: Actual download would require ytdl or similar
                        // For demo, sending just info
                        
                    } catch (error) {
                        console.error('Song error:', error);
                        await socket.sendMessage(sender, {
                            text: '❌ ғᴀɪʟᴇᴅ ᴛᴏ sᴇᴀʀᴄʜ sᴏɴɢ'
                        }, { quoted: fakevCard });
                    }
                    
                    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
                    break;
                }

                // ==================== DEFAULT ====================

                default: {
                    if (command && isCmd) {
                        await socket.sendMessage(sender, {
                            text: formatMessage('❌ ᴜɴᴋɴᴏᴡɴ ᴄᴏᴍᴍᴀɴᴅ',
                                `ᴄᴏᴍᴍᴀɴᴅ "${command}" ɴᴏᴛ ғᴏᴜɴᴅ.\nᴛʏᴘᴇ *.menu* ᴛᴏ sᴇᴇ ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs.`)
                        }, { quoted: fakevCard });
                    }
                    break;
                }
            }
        } catch (error) {
            console.error('Command error:', error);
            await socket.sendMessage(sender, {
                text: formatMessage('❌ ᴇʀʀᴏʀ',
                    `ᴀɴ ᴇʀʀᴏʀ ᴏᴄᴄᴜʀʀᴇᴅ:\n${error.message || 'Unknown error'}`)
            }, { quoted: fakevCard });
        }
    });
}

// ==================== PAIRING FUNCTION ====================

async function createBotSession(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(config.SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari'),
            syncFullHistory: false
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        // Setup handlers
        setupStatusHandlers(socket, sanitizedNumber);
        setupCommandHandlers(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let code;
            let retries = config.MAX_RETRIES;
            
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${error.message}, retries left: ${retries}`);
                    await delay(2000);
                }
            }
            
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            console.log(`✅ Creds updated for ${sanitizedNumber}`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    
                    // Save to active sockets
                    activeSockets.set(sanitizedNumber, socket);
                    
                    // Update user in database
                    await updateUserStats(sanitizedNumber);
                    
                    // Save number to file
                    let numbers = [];
                    if (fs.existsSync(config.NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(config.NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(config.NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                    
                    // Try to join group
                    try {
                        const inviteCodeMatch = config.GROUP_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (inviteCodeMatch) {
                            const inviteCode = inviteCodeMatch[1];
                            await socket.groupAcceptInvite(inviteCode);
                        }
                    } catch (groupError) {
                        console.warn('Failed to join group:', groupError.message);
                    }
                    
                    // Welcome message
                    await socket.sendMessage(userJid, {
                        image: { url: config.WELCOME_IMAGE },
                        caption: `╭━━━〔 *${config.BOT_NAME}* 〕━━┈⊷
┃🫶│ɴᴜᴍʙᴇʀ: ${sanitizedNumber}
┃🫶│ᴏᴡɴᴇʀ: ${config.BOT_OWNER}
┃🫶│ᴛɪᴍᴇ: ${getSriLankaTimestamp()}
┃🫶│sᴛᴀᴛᴜs: ᴄᴏɴɴᴇᴄᴛᴇᴅ ✅
╰──────────────┈⊷

🫶💗 *${config.BOT_NAME} බොට් වෙත සාදරයෙන් පිළිගනිමු!*

ᴛʏᴘᴇ *.menu* ᴛᴏ sᴇᴇ ᴄᴏᴍᴍᴀɴᴅs

${config.BOT_FOOTER}`
                    });
                    
                    console.log(`✅ Bot connected for ${sanitizedNumber}`);
                    
                } catch (error) {
                    console.error('Connection open error:', error);
                }
            }
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                if (statusCode === 401) {
                    console.log(`❌ Bot logged out for ${sanitizedNumber}`);
                    activeSockets.delete(sanitizedNumber);
                    
                    // Clean up session
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                } else {
                    console.log(`🔄 Reconnecting ${sanitizedNumber}...`);
                    activeSockets.delete(sanitizedNumber);
                    await delay(10000);
                    createBotSession(sanitizedNumber, { headersSent: false });
                }
            }
        });

    } catch (error) {
        console.error('Bot creation error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// ==================== ROUTES ====================

router.get('/', async (req, res) => {
    const { number } = req.query;
    
    if (!number) {
        return res.status(400).send({ error: 'Number is required' });
    }
    
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    
    if (activeSockets.has(sanitizedNumber)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'Bot is already connected for this number'
        });
    }
    
    await createBotSession(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/stats', async (req, res) => {
    try {
        const userCount = await User.countDocuments();
        const groupCount = await Group.countDocuments();
        const cmdStats = await CommandStats.find().sort({ count: -1 }).limit(10);
        
        res.status(200).send({
            active: activeSockets.size,
            users: userCount,
            groups: groupCount,
            commands: cmdStats
        });
    } catch (error) {
        res.status(500).send({ error: 'Failed to get stats' });
    }
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        bot: config.BOT_NAME,
        owner: config.BOT_OWNER,
        active: activeSockets.size,
        time: getSriLankaTimestamp()
    });
});

// ==================== CLEANUP ====================

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try {
            socket.ws.close();
        } catch (error) {}
    });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

module.exports = router;