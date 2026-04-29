// src/sockets/exports.js
//
// Module-level Socket.IO instance registry.
// Call setIO(io) once at server boot after Socket.IO is initialized.
// All controllers that need to emit events call getIO().
//
// The helper functions (sendTripOfferToDriver etc.) live in driver_socket.js.
// The original exports.js tried to require('./helpers') which never existed —
// that file is driver_socket.js.

'use strict';

const {
    sendTripOfferToDriver,
    notifyDriverTripCanceled,
    isDriverConnected,
} = require('./driver.socket');

let ioInstance = null;

const setIO = (io) => {
    ioInstance = io;
    console.log('✅ [SOCKET] io instance registered in exports.js');
};

const getIO = () => {
    if (!ioInstance) {
        throw new Error('Socket.IO not initialized — call setIO(io) at server boot');
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