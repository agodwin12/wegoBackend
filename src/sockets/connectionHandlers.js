// src/sockets/connectionHandlers.js
module.exports = (io, socket) => {
    socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
    });

    socket.on('connection:test', () => {
        socket.emit('connection:success', {
            userId: socket.userId,
            userType: socket.userType,
            socketId: socket.id,
            timestamp: Date.now()
        });
        console.log(`✅ [CONNECTION] Test successful for ${socket.userId}`);
    });
};