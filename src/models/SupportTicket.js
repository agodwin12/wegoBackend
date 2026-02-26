const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SupportTicket = sequelize.define('SupportTicket', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        allowNull: false
    },
    ticket_number: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: true
    },
    user_id: {
        type: DataTypes.UUID,
        allowNull: false,
        comment: 'Account UUID of the user who created the ticket'
    },
    subject: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    message: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    status: {
        type: DataTypes.ENUM('open', 'in_progress', 'resolved', 'closed'),
        allowNull: false,
        defaultValue: 'open'
    },
    priority: {
        type: DataTypes.ENUM('low', 'medium', 'high', 'urgent'),
        allowNull: false,
        defaultValue: 'medium'
    },
    category: {
        type: DataTypes.STRING(100),
        allowNull: true
    },
    assigned_to: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Employee ID (integer) who is assigned to this ticket'
    }
}, {
    tableName: 'support_tickets',
    timestamps: true,
    hooks: {
        beforeCreate: async (ticket) => {
            // Generate unique ticket number
            if (!ticket.ticket_number) {
                const timestamp = Date.now().toString().slice(-8);
                const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                ticket.ticket_number = `TKT-${timestamp}${random}`;
            }
        }
    }
});

/* ================================
   INSTANCE METHODS
================================= */

/**
 * Check if ticket is open
 * @returns {boolean}
 */
SupportTicket.prototype.isOpen = function() {
    return this.status === 'open' || this.status === 'in_progress';
};

/**
 * Check if ticket is assigned
 * @returns {boolean}
 */
SupportTicket.prototype.isAssigned = function() {
    return this.assigned_to !== null;
};

/**
 * Get ticket age in hours
 * @returns {number}
 */
SupportTicket.prototype.getAgeInHours = function() {
    const now = new Date();
    const created = new Date(this.createdAt);
    return Math.floor((now - created) / (1000 * 60 * 60));
};

/**
 * Get safe object representation
 * @returns {object}
 */
SupportTicket.prototype.toSafeObject = function() {
    const data = this.toJSON();
    return {
        ...data,
        is_open: this.isOpen(),
        is_assigned: this.isAssigned(),
        age_hours: this.getAgeInHours()
    };
};

/* ================================
   CLASS METHODS
================================= */

/**
 * Find open tickets
 * @returns {Promise<SupportTicket[]>}
 */
SupportTicket.findOpen = async function() {
    return await this.findAll({
        where: {
            status: ['open', 'in_progress']
        },
        order: [['createdAt', 'DESC']]
    });
};

/**
 * Find unassigned tickets
 * @returns {Promise<SupportTicket[]>}
 */
SupportTicket.findUnassigned = async function() {
    return await this.findAll({
        where: {
            assigned_to: null,
            status: ['open', 'in_progress']
        },
        order: [['priority', 'DESC'], ['createdAt', 'ASC']]
    });
};

/**
 * Find by ticket number
 * @param {string} ticketNumber
 * @returns {Promise<SupportTicket|null>}
 */
SupportTicket.findByTicketNumber = async function(ticketNumber) {
    return await this.findOne({
        where: { ticket_number: ticketNumber }
    });
};

/**
 * Generate unique ticket number
 * @returns {Promise<string>}
 */
SupportTicket.generateTicketNumber = async function() {
    let isUnique = false;
    let ticketNumber = '';
    let attempts = 0;

    while (!isUnique && attempts < 20) {
        const timestamp = Date.now().toString().slice(-8);
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        ticketNumber = `TKT-${timestamp}${random}`;

        const existing = await this.findByTicketNumber(ticketNumber);
        if (!existing) {
            isUnique = true;
        }
        attempts++;
    }

    return ticketNumber;
};

module.exports = SupportTicket;