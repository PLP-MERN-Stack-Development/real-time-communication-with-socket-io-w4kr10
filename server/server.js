// server.js - Main server file for Socket.io chat application

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store connected users, messages, and rooms
const users = {};
const messages = [];
const typingUsers = {};
const rooms = {
  'general': { name: 'General', users: {} },
  'random': { name: 'Random', users: {} }
};

// Store unread messages count per user
const unreadMessages = {};

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Handle user joining
  socket.on('user_join', (username) => {
    users[socket.id] = { username, id: socket.id };
    // Join default room
    socket.join('general');
    rooms['general'].users[socket.id] = username;
    
    io.emit('user_list', Object.values(users));
    io.emit('user_joined', { username, id: socket.id });
    // Send room list to user
    socket.emit('room_list', Object.values(rooms));
    console.log(`${username} joined the chat`);
  });

  // Handle chat messages
  socket.on('send_message', (messageData) => {
    const message = {
      ...messageData,
      id: Date.now(),
      sender: users[socket.id]?.username || 'Anonymous',
      senderId: socket.id,
      timestamp: new Date().toISOString(),
      delivered: true,
    };
    
    messages.push(message);
    
    // Limit stored messages to prevent memory issues
    if (messages.length > 1000) {
      messages.shift();
    }
    
    // Emit to specific room if provided, otherwise to all
    if (messageData.room) {
      io.to(messageData.room).emit('receive_message', message);
      // Send notification to users in the room
      Object.keys(rooms[messageData.room].users).forEach(userId => {
        if (userId !== socket.id) {
          socket.to(userId).emit('new_message_notification', {
            message: `${message.sender}: ${message.message}`,
            sender: message.sender,
            roomId: messageData.room
          });
          // Update unread count
          unreadMessages[userId] = (unreadMessages[userId] || 0) + 1;
          socket.to(userId).emit('unread_count_update', unreadMessages[userId]);
        }
      });
    } else {
      io.emit('receive_message', message);
      // Send notification to all users except sender
      Object.keys(users).forEach(userId => {
        if (userId !== socket.id) {
          socket.to(userId).emit('new_message_notification', {
            message: `${message.sender}: ${message.message}`,
            sender: message.sender
          });
          // Update unread count
          unreadMessages[userId] = (unreadMessages[userId] || 0) + 1;
          socket.to(userId).emit('unread_count_update', unreadMessages[userId]);
        }
      });
    }
    
    // Send delivery confirmation back to sender
    socket.emit('message_delivered', { messageId: message.id });
  });

  // Handle room creation
  socket.on('create_room', (roomName) => {
    const roomId = roomName.toLowerCase().replace(/\s+/g, '-');
    if (!rooms[roomId]) {
      rooms[roomId] = { name: roomName, users: {} };
      io.emit('room_list', Object.values(rooms));
      // Notify all users about new room
      io.emit('notification', {
        type: 'room_created',
        message: `New room created: ${roomName}`,
        roomId: roomId
      });
    }
  });

  // Handle joining a room
  socket.on('join_room', (roomId) => {
    // Leave current rooms
    socket.rooms.forEach(room => {
      if (room !== socket.id) {
        socket.leave(room);
        if (rooms[room]) {
          delete rooms[room].users[socket.id];
        }
      }
    });
    
    // Join new room
    socket.join(roomId);
    if (rooms[roomId]) {
      rooms[roomId].users[socket.id] = users[socket.id]?.username || 'Anonymous';
      socket.emit('room_joined', { roomId, roomName: rooms[roomId].name });
      // Notify room users about new member
      Object.keys(rooms[roomId].users).forEach(userId => {
        if (userId !== socket.id) {
          socket.to(userId).emit('notification', {
            type: 'user_joined_room',
            message: `${users[socket.id]?.username || 'Anonymous'} joined the room`,
            roomId: roomId
          });
        }
      });
    }
  });

  // Handle typing indicator
  socket.on('typing', (isTyping) => {
    if (users[socket.id]) {
      const username = users[socket.id].username;
      
      if (isTyping) {
        typingUsers[socket.id] = username;
      } else {
        delete typingUsers[socket.id];
      }
      
      io.emit('typing_users', Object.values(typingUsers));
    }
  });

  // Handle private messages
  socket.on('private_message', ({ to, message }) => {
    const messageData = {
      id: Date.now(),
      sender: users[socket.id]?.username || 'Anonymous',
      senderId: socket.id,
      message,
      timestamp: new Date().toISOString(),
      isPrivate: true,
      delivered: true,
    };
    
    socket.to(to).emit('private_message', messageData);
    socket.emit('private_message', messageData);
    
    // Send notification for private message
    socket.to(to).emit('new_message_notification', {
      message: `Private message from ${messageData.sender}: ${message}`,
      sender: messageData.sender,
      isPrivate: true
    });
    
    // Update unread count for recipient
    unreadMessages[to] = (unreadMessages[to] || 0) + 1;
    socket.to(to).emit('unread_count_update', unreadMessages[to]);
    
    // Send delivery confirmation back to sender
    socket.emit('message_delivered', { messageId: messageData.id });
  });

  // Handle message reactions
  socket.on('add_reaction', ({ messageId, reaction }) => {
    // In a real app, you would update the message in your database
    // For now, we'll just broadcast the reaction
    io.emit('reaction_added', { messageId, reaction, userId: socket.id });
  });

  // Handle message read receipts
  socket.on('message_read', (messageId) => {
    // In a real app, you would update the message status in your database
    // For now, we'll just broadcast the read status
    socket.broadcast.emit('message_read_receipt', { messageId, userId: socket.id });
    // Reset unread count for this user
    unreadMessages[socket.id] = Math.max(0, (unreadMessages[socket.id] || 0) - 1);
    socket.emit('unread_count_update', unreadMessages[socket.id]);
  });

  // Handle file sharing
  socket.on('share_file', (fileData) => {
    const message = {
      id: Date.now(),
      sender: users[socket.id]?.username || 'Anonymous',
      senderId: socket.id,
      timestamp: new Date().toISOString(),
      fileType: fileData.type,
      fileName: fileData.name,
      fileUrl: fileData.url,
      isFile: true,
      delivered: true,
    };
    
    messages.push(message);
    
    if (messages.length > 1000) {
      messages.shift();
    }
    
    io.emit('receive_message', message);
    
    // Send notification for file share
    Object.keys(users).forEach(userId => {
      if (userId !== socket.id) {
        socket.to(userId).emit('new_message_notification', {
          message: `${message.sender} shared a file: ${message.fileName}`,
          sender: message.sender,
          isFile: true
        });
        // Update unread count
        unreadMessages[userId] = (unreadMessages[userId] || 0) + 1;
        socket.to(userId).emit('unread_count_update', unreadMessages[userId]);
      }
    });
    
    // Send delivery confirmation back to sender
    socket.emit('message_delivered', { messageId: message.id });
  });

  // Handle message pagination
  socket.on('load_messages', ({ offset, limit, roomId }) => {
    // Filter messages by room if specified
    let filteredMessages = messages;
    if (roomId) {
      filteredMessages = messages.filter(msg => msg.room === roomId);
    }
    
    // Sort messages by timestamp (newest first)
    filteredMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Apply pagination
    const paginatedMessages = filteredMessages.slice(offset, offset + limit);
    
    // Send messages to client
    socket.emit('messages_loaded', {
      messages: paginatedMessages,
      hasMore: offset + limit < filteredMessages.length
    });
  });

  // Handle message search
  socket.on('search_messages', ({ query, roomId }) => {
    // Filter messages by room if specified
    let filteredMessages = messages;
    if (roomId) {
      filteredMessages = messages.filter(msg => msg.room === roomId);
    }
    
    // Filter messages by search query
    const searchResults = filteredMessages.filter(msg => 
      msg.message && msg.message.toLowerCase().includes(query.toLowerCase())
    );
    
    // Sort messages by timestamp (newest first)
    searchResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Limit search results
    const limitedResults = searchResults.slice(0, 50);
    
    // Send search results to client
    socket.emit('search_results', {
      messages: limitedResults,
      query: query
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    if (users[socket.id]) {
      const { username } = users[socket.id];
      io.emit('user_left', { username, id: socket.id });
      console.log(`${username} left the chat`);
      
      // Notify users about user leaving
      Object.keys(users).forEach(userId => {
        if (userId !== socket.id) {
          socket.to(userId).emit('notification', {
            type: 'user_left',
            message: `${username} left the chat`
          });
        }
      });
    }
    
    // Remove user from all rooms
    Object.keys(rooms).forEach(roomId => {
      delete rooms[roomId].users[socket.id];
    });
    
    delete users[socket.id];
    delete typingUsers[socket.id];
    delete unreadMessages[socket.id];
    
    io.emit('user_list', Object.values(users));
    io.emit('typing_users', Object.values(typingUsers));
    io.emit('room_list', Object.values(rooms));
  });
});

// API routes
app.get('/api/messages', (req, res) => {
  const { offset = 0, limit = 50, room } = req.query;
  
  // Filter messages by room if specified
  let filteredMessages = messages;
  if (room) {
    filteredMessages = messages.filter(msg => msg.room === room);
  }
  
  // Sort messages by timestamp (newest first)
  filteredMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Apply pagination
  const paginatedMessages = filteredMessages.slice(offset, offset + limit);
  
  res.json({
    messages: paginatedMessages,
    hasMore: offset + limit < filteredMessages.length
  });
});

app.get('/api/search', (req, res) => {
  const { q, room } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }
  
  // Filter messages by room if specified
  let filteredMessages = messages;
  if (room) {
    filteredMessages = messages.filter(msg => msg.room === room);
  }
  
  // Filter messages by search query
  const searchResults = filteredMessages.filter(msg => 
    msg.message && msg.message.toLowerCase().includes(q.toLowerCase())
  );
  
  // Sort messages by timestamp (newest first)
  searchResults.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  // Limit search results
  const limitedResults = searchResults.slice(0, 50);
  
  res.json({
    messages: limitedResults,
    query: q
  });
});

app.get('/api/users', (req, res) => {
  res.json(Object.values(users));
});

app.get('/api/rooms', (req, res) => {
  res.json(Object.values(rooms));
});

// Root route
app.get('/', (req, res) => {
  res.send('Socket.io Chat Server is running');
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = { app, server, io };