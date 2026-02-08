const { v4: uuidv4 } = require('uuid');
const { uniqueUsernameGenerator, adjectives, nouns } = require('unique-username-generator');
const { getDistanceFromLatLonInMeters } = require('../utils/geo');

class RoomManager {
    constructor() {
        this.rooms = new Map(); // roomId -> Room object
        this.users = new Map(); // socketId -> User object
    }

    // Generate a random anonymous user
    createUser(socketId) {
        const config = {
            dictionaries: [adjectives, nouns],
            separator: ' ',
            length: 2,
            style: 'capital'
        };

        const username = uniqueUsernameGenerator(config);
        const user = {
            id: socketId,
            username: username,
            avatar: Math.floor(Math.random() * 10) + 1, // 1-10 for avatar selection
            roomId: null,
            lat: null,
            lon: null,
            radius: null,
            status: 'AVAILABLE', // 'AVAILABLE', 'BUSY'
            joinedAt: Date.now()
        };

        this.users.set(socketId, user);
        return user;
    }

    getUser(socketId) {
        return this.users.get(socketId);
    }

    // Register user location and radius
    registerLocation(socketId, lat, lon, radius) {
        const user = this.users.get(socketId);
        if (!user) return null;

        user.lat = lat;
        user.lon = lon;
        user.radius = radius;
        user.status = 'AVAILABLE';
        return user;
    }

    // Find nearby available users
    findNearbyUsers(socketId) {
        const currentUser = this.users.get(socketId);
        if (!currentUser || !currentUser.lat || !currentUser.lon) return [];

        const nearbyUsers = [];
        for (const [id, user] of this.users.entries()) {
            if (id === socketId) continue;
            if (user.status !== 'AVAILABLE') continue;
            if (!user.lat || !user.lon) continue;

            const distance = getDistanceFromLatLonInMeters(
                currentUser.lat, currentUser.lon,
                user.lat, user.lon
            );

            // Check if user is within current user's radius
            // AND current user is within other user's radius (mutual discovery logic preferred, or just one way?)
            // Usually for matching, distance should be < min(radius A, radius B) or just A's radius.
            // Let's stick to A's radius for now as "Who is around ME".

            if (distance <= currentUser.radius) {
                nearbyUsers.push({
                    id: user.id,
                    username: user.username,
                    avatar: user.avatar,
                    distance: Math.round(distance) // send rounded distance
                });
            }
        }
        return nearbyUsers.sort((a, b) => a.distance - b.distance);
    }

    // Create a private room between two users
    createPrivateRoom(userAId, userBId) {
        const userA = this.users.get(userAId);
        const userB = this.users.get(userBId);

        if (!userA || !userB) return null;
        if (userA.status !== 'AVAILABLE' || userB.status !== 'AVAILABLE') return null;

        const roomId = uuidv4();
        const newRoom = {
            id: roomId,
            users: [userA, userB],
            createdAt: Date.now(),
            type: 'private'
        };

        this.rooms.set(roomId, newRoom);

        userA.roomId = roomId;
        userB.roomId = roomId;
        userA.status = 'BUSY';
        userB.status = 'BUSY';

        return newRoom;
    }

    leaveRoom(socketId) {
        const user = this.users.get(socketId);
        if (!user || !user.roomId) return null;

        const roomId = user.roomId;
        const room = this.rooms.get(roomId);

        if (room) {
            // Remove user from room
            room.users = room.users.filter(u => u.id !== socketId);
            user.roomId = null;
            user.status = 'AVAILABLE'; // Mark as available again when leaving

            // If room is empty or 1-on-1 and one left, typically we destroy it or notify other
            // For 1-on-1, if one leaves, the chat is essentially over.

            const remainingUsers = room.users;

            // Mark remaining user as available if it was a private chat and now it's just them?
            // Or keep them in room waiting?
            // Requirement: "When all users leave, room auto-destroy".
            // But for 1-on-1, if one leaves, the other should probably be notified and chat ended.

            if (room.users.length === 0) {
                this.rooms.delete(roomId);
                return { roomId, user, roomDestroyed: true, remainingUsers: [] };
            } else {
                // If it was private, the other user is now alone. 
                // We might want to "kick" them out or just let them leave manually.
                // For safety/UX, usually if one leaves a private chat, it ends.
                // Let's destroy room if it was private and one left.
                if (room.type === 'private') {
                    // Get the other user
                    const otherUser = room.users[0];
                    otherUser.roomId = null;
                    otherUser.status = 'AVAILABLE';
                    this.rooms.delete(roomId);
                    return { roomId, user, roomDestroyed: true, remainingUsers: [otherUser], wasPrivate: true };
                }
            }

            return { roomId, user, roomDestroyed: false, remainingUsers: room.users };
        }
        return null;
    }

    removeUser(socketId) {
        this.leaveRoom(socketId);
        this.users.delete(socketId);
    }
}

module.exports = new RoomManager();
