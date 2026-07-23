// src/controllers/partnerPortal.controller.js
//
// ═══════════════════════════════════════════════════════════════════════════
// PARTNER PORTAL — what a rental partner sees about their own fleet
// ═══════════════════════════════════════════════════════════════════════════
// A partner owns vehicles that WEGO rents out on their behalf. They need to
// know whether each vehicle is currently with a customer or back on the lot —
// and nothing about the money: pricing is WEGO's side of the relationship, so
// no amount ever leaves this controller. Rental rows are read with an explicit
// attribute whitelist to make that structural rather than a convention.
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

const { Op } = require('sequelize');
const { PartnerProfile, Vehicle, VehicleRental } = require('../models');

/**
 * @route  GET /api/partner/vehicles
 * @desc   The caller's own vehicles with their rental state.
 * @access Private — PARTNER accounts only.
 */
exports.getMyVehicles = async (req, res) => {
    try {
        if (req.user.user_type !== 'PARTNER') {
            return res.status(403).json({
                success: false,
                message: 'Réservé aux comptes partenaires.',
                code: 'PARTNER_ONLY',
            });
        }

        const profile = await PartnerProfile.findByAccountId(req.user.uuid);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profil partenaire introuvable.',
                code: 'PARTNER_PROFILE_NOT_FOUND',
            });
        }

        const vehicles = await Vehicle.findAll({
            where: { partnerId: profile.id },
            order: [['createdAt', 'DESC']],
        });

        if (vehicles.length === 0) {
            return res.status(200).json({ success: true, data: { vehicles: [] } });
        }

        // One query for every rental that can influence a vehicle's state.
        // NO price attributes — the whitelist is the privacy boundary.
        const rentals = await VehicleRental.findAll({
            where: {
                vehicleId: { [Op.in]: vehicles.map((v) => v.id) },
                status: { [Op.in]: ['CONFIRMED', 'COMPLETED'] },
            },
            attributes: ['id', 'vehicleId', 'startDate', 'endDate', 'status'],
            order: [['startDate', 'DESC']],
        });

        const now = new Date();
        const byVehicle = new Map();
        for (const r of rentals) {
            if (!byVehicle.has(r.vehicleId)) byVehicle.set(r.vehicleId, []);
            byVehicle.get(r.vehicleId).push(r);
        }

        const data = vehicles.map((v) => {
            const list = byVehicle.get(v.id) || [];

            // A CONFIRMED rental means the keys are with a customer until the
            // backoffice marks it COMPLETED — even past its end date (overdue).
            const current = list.find((r) => r.status === 'CONFIRMED') || null;
            const lastReturn = list.find((r) => r.status === 'COMPLETED') || null;

            const images = Array.isArray(v.images) ? v.images : [];

            return {
                id: v.id,
                plate: v.plate,
                make_model: v.makeModel,
                year: v.year,
                color: v.color,
                region: v.region,
                image: images[0] || null,
                is_blocked: !!v.isBlocked,
                status: current ? 'RENTED_OUT' : 'AVAILABLE',
                current_rental: current
                    ? {
                        start_date: current.startDate,
                        end_date: current.endDate,
                        overdue: new Date(current.endDate) < now,
                    }
                    : null,
                last_return: lastReturn ? lastReturn.endDate : null,
            };
        });

        const out = data.filter((v) => v.status === 'RENTED_OUT').length;
        return res.status(200).json({
            success: true,
            data: {
                vehicles: data,
                summary: {
                    total: data.length,
                    rented_out: out,
                    available: data.length - out,
                },
            },
        });
    } catch (error) {
        console.error('❌ [PARTNER PORTAL] getMyVehicles:', error);
        return res.status(500).json({
            success: false,
            message: 'Impossible de charger vos véhicules. Veuillez réessayer.',
        });
    }
};
