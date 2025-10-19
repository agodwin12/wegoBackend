// src/sockets/exports.js

const { sendTripOfferToDriver, notifyDriverTripCanceled, isDriverConnected } = require('./helpers');

let ioInstance = null;

const setIO = (io) => {
    ioInstance = io;
};

const getIO = () => {
    if (!ioInstance) {
        throw new Error('Socket.IO not initialized');
    }
    return ioInstance;
};

module.exports = {
    setIO,
    getIO,
    sendTripOfferToDriver,
    notifyDriverTripCanceled,
    isDriverConnected,
};