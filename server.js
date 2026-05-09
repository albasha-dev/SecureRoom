const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Database Setup
const db = new Database('database.db');
db.pragma('journal_mode = WAL');

// Initialize Tables
db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        code TEXT UNIQUE,
        has_password INTEGER,
        salt TEXT,
        verification_token TEXT,
        created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT,
        sender TEXT,
        sender_tab_id TEXT,
        encrypted_data TEXT,
        timestamp INTEGER,
        FOREIGN KEY(room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT,
        tab_id TEXT,
        username TEXT,
        last_seen INTEGER,
        UNIQUE(room_id, tab_id)
    );
`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Endpoints
app.post('/api/rooms', (req, res) => {
    const { code, hasPassword, salt, verificationToken } = req.body;
    const id = uuidv4();
    try {
        const stmt = db.prepare('INSERT INTO rooms (id, code, has_password, salt, verification_token, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        stmt.run(id, code, hasPassword ? 1 : 0, salt, JSON.stringify(verificationToken), Date.now());
        res.json({ success: true, roomId: id });
    } catch (err) {
        res.status(400).json({ success: false, error: 'Room code already exists' });
    }
});

app.get('/api/rooms/:code', (req, res) => {
    const { code } = req.params;
    const room = db.prepare('SELECT * FROM rooms WHERE code = ?').get(code);
    if (room) {
        // Parse JSON strings
        if (room.verification_token) room.verification_token = JSON.parse(room.verification_token);
        res.json({ success: true, room });
    } else {
        res.status(404).json({ success: false, error: 'Room not found' });
    }
});

app.get('/api/rooms/:roomId/messages', (req, res) => {
    const { roomId } = req.params;
    const messages = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY timestamp ASC').all(roomId);
    messages.forEach(msg => {
        msg.encrypted_data = JSON.parse(msg.encrypted_data);
    });
    res.json({ success: true, messages });
});

// Socket.io Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', ({ roomId, tabId, username }) => {
        socket.join(roomId);
        
        // Add member to DB
        const stmt = db.prepare('INSERT OR REPLACE INTO members (room_id, tab_id, username, last_seen) VALUES (?, ?, ?, ?)');
        stmt.run(roomId, tabId, username, Date.now());

        // Broadcast join
        socket.to(roomId).emit('member-joined', { tabId, username });

        // Update member list for everyone
        const members = db.prepare('SELECT tab_id, username FROM members WHERE room_id = ?').all(roomId);
        io.to(roomId).emit('update-members', members);
    });

    socket.on('send-message', ({ roomId, message }) => {
        const msgId = uuidv4();
        const { sender, senderTabId, encryptedData, timestamp } = message;

        // Save to DB
        const stmt = db.prepare('INSERT INTO messages (id, room_id, sender, sender_tab_id, encrypted_data, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
        stmt.run(msgId, roomId, sender, senderTabId, JSON.stringify(encryptedData), timestamp);

        // Broadcast to others
        socket.to(roomId).emit('encrypted-message', {
            messageId: msgId,
            sender,
            senderTabId,
            encryptedData,
            timestamp
        });
    });

    socket.on('typing', ({ roomId, tabId, username }) => {
        socket.to(roomId).emit('typing', { tabId, username });
    });

    socket.on('leave-room', ({ roomId, tabId, username }) => {
        db.prepare('DELETE FROM members WHERE room_id = ? AND tab_id = ?').run(roomId, tabId);
        socket.to(roomId).emit('member-left', { tabId, username });
        
        const members = db.prepare('SELECT tab_id, username FROM members WHERE room_id = ?').all(roomId);
        io.to(roomId).emit('update-members', members);
        
        socket.leave(roomId);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        // Clean up inactive members (optional: depends on how strict you want to be)
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
