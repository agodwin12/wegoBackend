// backend/src/config/database.js
// Database Configuration - MySQL with Sequelize

const { Sequelize } = require('sequelize');
require('dotenv').config();

// ═══════════════════════════════════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════════════

const sequelize = new Sequelize(
    process.env.DB_NAME || 'WEGO',
    process.env.DB_USER || 'root',
    process.env.DB_PASS || '',
    {
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
        dialect: process.env.DB_DIALECT || 'mysql',
        logging: false,

        define: {
            charset: 'utf8mb4',
            collate: 'utf8mb4_unicode_ci',
            timestamps: true,
            underscored: false,
        },

        pool: {
            max: 10,
            min: 0,
            idle: 10000
        },

        timezone: '+01:00', // Cameroon timezone
    }
);

// ═══════════════════════════════════════════════════════════════════════
// TEST CONNECTION
// ═══════════════════════════════════════════════════════════════════════

const testConnection = async () => {
    try {
        await sequelize.authenticate();
        console.log('✅ Database connected successfully');
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
};

// ═══════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════

const closeDatabase = async () => {
    try {
        await sequelize.close();
        console.log('✅ Database connection closed');
    } catch (error) {
        console.error('❌ Error closing database:', error.message);
    }
};

process.on('SIGINT', async () => {
    await closeDatabase();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await closeDatabase();
    process.exit(0);
});

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

module.exports = sequelize;
module.exports.testConnection = testConnection;
module.exports.closeDatabase = closeDatabase;