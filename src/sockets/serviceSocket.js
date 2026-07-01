// backend/src/sockets/serviceSocket.js
// Services marketplace socket helpers — classifieds model (no booking lifecycle)

const getIO = () => {
    const io = require('../server').io;
    if (!io) {
        console.warn('⚠️ [SERVICE_SOCKET] Socket.IO instance not available');
        return null;
    }
    return io;
};

const emitToUser = (userUUID, event, data) => {
    try {
        const io = getIO();
        if (!io) return;
        io.to(userUUID).emit(event, data);
    } catch (error) {
        console.error(`❌ [SERVICE_SOCKET] Failed to emit "${event}" to ${userUUID}:`, error.message);
    }
};

module.exports = { emitToUser };
