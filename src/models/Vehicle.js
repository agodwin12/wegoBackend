// wegobackend/src/models/Vehicle.js

const { DataTypes, Model } = require('sequelize');
const sequelize = require('../config/database');

class Vehicle extends Model {
    // Instance method to verify vehicle
    async verify(employeeId) {
        this.isVerified = true;
        this.verifiedAt = new Date();
        this.verifiedByEmployeeId = employeeId;
        await this.save();
        return this;
    }

    // Instance method to unverify vehicle
    async unverify() {
        this.isVerified = false;
        this.verifiedAt = null;
        this.verifiedByEmployeeId = null;
        await this.save();
        return this;
    }

    // Instance method to block vehicle
    async block(reason) {
        this.isBlocked = true;
        this.blockedReason = reason;
        await this.save();
        return this;
    }

    // Instance method to unblock vehicle
    async unblock() {
        this.isBlocked = false;
        this.blockedReason = null;
        await this.save();
        return this;
    }

    // Instance method to update availability
    async updateAvailability(available) {
        this.availableForRent = available;
        await this.save();
        return this;
    }

    // Class method to get vehicles by partner
    static async getByPartner(partnerId, options = {}) {
        return await this.findAll({
            where: { partnerId },
            ...options
        });
    }

    // Class method to get available vehicles
    static async getAvailableVehicles(filters = {}) {
        const where = {
            availableForRent: true,
            isBlocked: false,
            ...filters
        };

        return await this.findAll({
            where,
            include: ['category', 'partner'],
            order: [['createdAt', 'DESC']]
        });
    }

    // Class method to get vehicles by region
    static async getByRegion(region) {
        return await this.findAll({
            where: { region, availableForRent: true, isBlocked: false },
            include: ['category', 'partner']
        });
    }

    // Class method to get vehicles by category
    static async getByCategory(categoryId) {
        return await this.findAll({
            where: { categoryId, availableForRent: true, isBlocked: false },
            include: ['partner']
        });
    }

    // Class method to find by plate
    static async findByPlate(plate) {
        return await this.findOne({ where: { plate } });
    }
}

Vehicle.init({
    id: {
        type: DataTypes.STRING(36),
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
    },
    plate: {
        type: DataTypes.STRING(24),
        allowNull: false,
        unique: true,
        validate: {
            notEmpty: { msg: 'License plate is required' },
            len: {
                args: [2, 24],
                msg: 'License plate must be between 2 and 24 characters'
            }
        }
    },
    makeModel: {
        type: DataTypes.STRING(64),
        allowNull: false,
        validate: {
            notEmpty: { msg: 'Make and model is required' },
            len: {
                args: [2, 64],
                msg: 'Make and model must be between 2 and 64 characters'
            }
        }
    },
    year: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
            min: {
                args: [1900],
                msg: 'Year must be 1900 or later'
            },
            max: {
                args: [new Date().getFullYear() + 1],
                msg: 'Year cannot be in the future'
            }
        }
    },
    color: {
        type: DataTypes.STRING(32),
        allowNull: true,
    },
    region: {
        type: DataTypes.STRING(64),
        allowNull: false,
        defaultValue: 'Littoral',
        validate: {
            isIn: {
                args: [['Littoral', 'Centre', 'Ouest', 'Nord', 'Sud', 'Est', 'Adamaoua', 'Extreme-Nord', 'Nord-Ouest', 'Sud-Ouest']],
                msg: 'Invalid region'
            }
        }
    },
    seats: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 4,
        validate: {
            min: {
                args: [1],
                msg: 'Seats must be at least 1'
            },
            max: {
                args: [50],
                msg: 'Seats cannot exceed 50'
            }
        }
    },
    transmission: {
        type: DataTypes.ENUM('manual', 'automatic'),
        allowNull: false,
        defaultValue: 'manual',
    },
    fuelType: {
        type: DataTypes.ENUM('petrol', 'diesel', 'electric', 'hybrid'),
        allowNull: false,
        defaultValue: 'petrol',
    },
    partnerId: {
        type: DataTypes.CHAR(36),
        allowNull: false,
        references: { model: 'accounts', key: 'uuid' },
    },
    postedByEmployeeId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
    },
    categoryId: {
        type: DataTypes.STRING(36),
        allowNull: true,
        references: { model: 'vehicle_categories', key: 'id' },
    },
    availableForRent: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    rentalPricePerHour: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: {
            min: {
                args: [0],
                msg: 'Price must be a positive number'
            }
        }
    },
    rentalPricePerDay: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: {
            min: {
                args: [0],
                msg: 'Price must be a positive number'
            }
        }
    },
    rentalPricePerWeek: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: {
            min: {
                args: [0],
                msg: 'Price must be a positive number'
            }
        }
    },
    rentalPricePerMonth: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: {
            min: {
                args: [0],
                msg: 'Price must be a positive number'
            }
        }
    },
    rentalCurrency: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'XAF',
    },
    images: {
        type: DataTypes.JSON,
        allowNull: true,
        defaultValue: [],
        get() {
            const rawValue = this.getDataValue('images');
            if (!rawValue) return [];
            if (typeof rawValue === 'string') {
                try {
                    return JSON.parse(rawValue);
                } catch (e) {
                    return [];
                }
            }
            return rawValue;
        }
    },
    insuranceDocument: {
        type: DataTypes.STRING(500),
        allowNull: true,
    },
    insuranceExpiry: {
        type: DataTypes.DATEONLY,
        allowNull: true,
    },
    permitDocument: {
        type: DataTypes.STRING(500),
        allowNull: true,
    },
    permitExpiry: {
        type: DataTypes.DATEONLY,
        allowNull: true,
    },
    lastMaintenanceDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
    },
    nextMaintenanceDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
    },
    isVerified: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    verifiedAt: {
        type: DataTypes.DATE,
        allowNull: true,
    },
    verifiedByEmployeeId: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
    },
    isBlocked: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    },
    blockedReason: {
        type: DataTypes.TEXT,
        allowNull: true,
    }
}, {
    sequelize,
    modelName: 'Vehicle',
    tableName: 'vehicles',
    timestamps: true,
    underscored: true,
    hooks: {
        beforeValidate: (vehicle) => {
            // Trim whitespace
            if (vehicle.plate) vehicle.plate = vehicle.plate.trim().toUpperCase();
            if (vehicle.makeModel) vehicle.makeModel = vehicle.makeModel.trim();
            if (vehicle.color) vehicle.color = vehicle.color.trim();
        }
    }
});

module.exports = Vehicle;