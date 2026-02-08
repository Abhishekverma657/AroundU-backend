require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const roomManager = require('./services/RoomManager');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Basic health check
app.get('/', (req, res) => {
    res.send('AroundU Backend is running');
});

const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || '*',
        methods: ['GET', 'POST']
    }
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial user setup
    const user = roomManager.createUser(socket.id);
    socket.emit('session_config', { user });

    // Handle user location registration
    socket.on('register_location', ({ lat, lon, radius }) => {
        if (!lat || !lon || !radius) {
            socket.emit('error', { message: 'Invalid location data' });
            return;
        }

        const updatedUser = roomManager.registerLocation(socket.id, lat, lon, radius);
        if (updatedUser) {
            socket.emit('registration_success', { user: updatedUser });

            // Immediately send nearby users
            const nearbyUsers = roomManager.findNearbyUsers(socket.id);
            socket.emit('nearby_users', { users: nearbyUsers });
        }
    });

    // Handle request to refresh nearby users
    socket.on('get_nearby_users', () => {
        const nearbyUsers = roomManager.findNearbyUsers(socket.id);
        socket.emit('nearby_users', { users: nearbyUsers });
    });

    // Handle chat request
    socket.on('request_chat', ({ targetUserId }) => {
        const currentUser = roomManager.getUser(socket.id);
        const targetUser = roomManager.getUser(targetUserId);

        if (!currentUser || !targetUser) {
            socket.emit('error', { message: 'User not found' });
            return;
        }

        if (targetUser.status !== 'AVAILABLE') {
            socket.emit('error', { message: 'User is currently busy' });
            return;
        }

        // Notify target user
        io.to(targetUserId).emit('incoming_request', {
            from: {
                id: currentUser.id,
                username: currentUser.username,
                avatar: currentUser.avatar
            }
        });
    });

    // Handle chat response (accept/reject)
    socket.on('respond_chat', ({ targetUserId, accept }) => {
        const currentUser = roomManager.getUser(socket.id);

        if (accept) {
            // Try to create room
            const room = roomManager.createPrivateRoom(currentUser.id, targetUserId);

            if (room) {
                // Join both sockets to the room
                socket.join(room.id);
                const targetSocket = io.sockets.sockets.get(targetUserId);
                if (targetSocket) {
                    targetSocket.join(room.id);
                }

                // Notify both users
                io.to(room.id).emit('room_joined', { room });

                // Send initial users list
                io.to(room.id).emit('room_users', { users: room.users });
            } else {
                socket.emit('error', { message: 'Could not create chat room. User might be busy.' });
                io.to(targetUserId).emit('chat_rejected', { fromId: socket.id });
            }
        } else {
            // Notify requester that request was rejected
            io.to(targetUserId).emit('chat_rejected', { fromId: socket.id });
        }
    });

    // Handle messages
    socket.on('send_message', (messageText) => {
        const user = roomManager.users.get(socket.id);
        if (!user || !user.roomId) return;

        const message = {
            id: Date.now().toString(),
            userId: user.id,
            username: user.username,
            avatar: user.avatar,
            text: messageText,
            timestamp: new Date().toISOString()
        };

        io.to(user.roomId).emit('receive_message', message);
    });

    // Handle typing
    socket.on('typing', (isTyping) => {
        const user = roomManager.users.get(socket.id);
        if (!user || !user.roomId) return;

        socket.to(user.roomId).emit('user_typing', { userId: user.id, isTyping });
    });

    // Handle disconnect/leave
    socket.on('leave_room', () => {
        const result = roomManager.leaveRoom(socket.id);
        if (result) {
            socket.leave(result.roomId);
            const { roomId, user, roomDestroyed, remainingUsers, wasPrivate } = result;

            if (wasPrivate && roomDestroyed && remainingUsers.length > 0) {
                // Notify the other user that chat ended
                const otherUser = remainingUsers[0];
                io.to(otherUser.id).emit('chat_ended', { reason: 'partner_left' });

                // Make sure other socket leaves room too
                const otherSocket = io.sockets.sockets.get(otherUser.id);
                if (otherSocket) otherSocket.leave(roomId);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const result = roomManager.removeUser(socket.id);

        if (result) {
            const { roomId, user, roomDestroyed, remainingUsers, wasPrivate } = result;

            if (wasPrivate && roomDestroyed && remainingUsers.length > 0) {
                const otherUser = remainingUsers[0];
                io.to(otherUser.id).emit('chat_ended', { reason: 'partner_disconnected' });

                const otherSocket = io.sockets.sockets.get(otherUser.id);
                if (otherSocket) otherSocket.leave(roomId);
            } else if (!roomDestroyed) {
                socket.to(roomId).emit('user_left', { userId: user.id });
                socket.to(roomId).emit('room_users', { users: remainingUsers });
            }
        }
    });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
