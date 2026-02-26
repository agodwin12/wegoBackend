// src/models/PendingSignup.js
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PendingSignup = sequelize.define(
    'PendingSignup',
    {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        uuid: {
            type: DataTypes.UUID,
            allowNull: false,
            unique: true,
            comment: 'Pre-generated UUID for this signup attempt',
        },
        user_type: {
            type: DataTypes.ENUM('PASSENGER', 'DRIVER'),
            allowNull: false,
            comment: 'Type of account being created',
        },

        // ─────────────────────────────────────────────────────────
        // CONTACT INFORMATION
        // ─────────────────────────────────────────────────────────
        email: {
            type: DataTypes.STRING(255),
            allowNull: true,
            validate: {
                isEmail: true,
            },
            comment: 'Email address (optional, but email OR phone required)',
        },
        phone_e164: {
            type: DataTypes.STRING(20),
            allowNull: true,
            comment: 'Phone number in E.164 format (optional, but email OR phone required)',
        },

        // ─────────────────────────────────────────────────────────
        // PERSONAL INFORMATION
        // ─────────────────────────────────────────────────────────
        civility: {
            type: DataTypes.STRING(10),
            allowNull: true,
            comment: 'Mr, Mrs, Ms, etc.',
        },
        first_name: {
            type: DataTypes.STRING(100),
            allowNull: true,
            comment: 'User first name',
        },
        last_name: {
            type: DataTypes.STRING(100),
            allowNull: true,
            comment: 'User last name',
        },
        birth_date: {
            type: DataTypes.DATEONLY,
            allowNull: true,
            comment: 'Date of birth',
        },
        password_hash: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Bcrypt hashed password',
        },

        // ─────────────────────────────────────────────────────────
        // FILE URLS (Already uploaded to R2)
        // ─────────────────────────────────────────────────────────
        avatar_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Profile photo URL from Cloudflare R2',
        },

        // ─────────────────────────────────────────────────────────
        // DRIVER-SPECIFIC DATA (Stored as JSON for flexibility)
        // ─────────────────────────────────────────────────────────
        driver_data: {
            type: DataTypes.JSON,
            allowNull: true,
            comment: 'Driver-specific fields stored as JSON',
            // Contains: cni_number, license_number, license_expiry, insurance_number,
            // insurance_expiry, vehicle_type, vehicle_make_model, vehicle_color,
            // vehicle_year, vehicle_plate
        },

        // Driver document URLs
        license_document_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Driver license document URL from R2',
        },
        insurance_document_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Insurance document URL from R2',
        },
        vehicle_photo_url: {
            type: DataTypes.TEXT,
            allowNull: true,
            comment: 'Vehicle photo URL from R2',
        },

        // ─────────────────────────────────────────────────────────
        // TRACKING & EXPIRY
        // ─────────────────────────────────────────────────────────
        otp_sent_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Timestamp when OTP was sent',
        },
        expires_at: {
            type: DataTypes.DATE,
            allowNull: true,
            comment: 'Expiry time for this pending signup (default: 30 minutes)',
        },
    },
    {
        tableName: 'pending_signups',
        underscored: true,
        timestamps: true, // Adds created_at and updated_at
        indexes: [
            {
                unique: true,
                fields: ['uuid'],
            },
            {
                fields: ['email'],
            },
            {
                fields: ['phone_e164'],
            },
            {
                fields: ['expires_at'],
            },
        ],
    }
);

module.exports = PendingSignup;