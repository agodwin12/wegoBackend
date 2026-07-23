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
const { Account, Vehicle, VehicleRental } = require('../models');

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

        // vehicles.partner_id is a foreign key onto accounts.uuid — NOT onto
        // partner_profiles.id (checked against the live schema: constraint
        // vehicles_ibfk_1 REFERENCES accounts(uuid)). The caller's account
        // uuid IS the vehicle owner key, no profile lookup needed.
        const vehicles = await Vehicle.findAll({
            where: { partnerId: req.user.uuid },
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
            attributes: ['id', 'vehicleId', 'userId', 'startDate', 'endDate', 'status'],
            order: [['startDate', 'DESC']],
        });

        // The partner may know WHO holds their car — name only, no contact
        // details: WEGO stays the intermediary.
        const renterIds = [...new Set(rentals.map((r) => r.userId).filter(Boolean))];
        const renters = renterIds.length
            ? await Account.findAll({
                where: { uuid: { [Op.in]: renterIds } },
                attributes: ['uuid', 'first_name', 'last_name'],
            })
            : [];
        const renterName = new Map(
            renters.map((a) => [
                a.uuid,
                `${a.first_name || ''} ${a.last_name || ''}`.trim() || null,
            ])
        );

        const now = new Date();
        const byVehicle = new Map();
        for (const r of rentals) {
            if (!byVehicle.has(r.vehicleId)) byVehicle.set(r.vehicleId, []);
            byVehicle.get(r.vehicleId).push(r);
        }

        const DAY_MS = 24 * 60 * 60 * 1000;

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
                // How often this vehicle has gone out — feeds the partner's
                // "most rented" ranking.
                times_rented: list.length,
                current_rental: current
                    ? {
                        start_date: current.startDate,
                        end_date: current.endDate,
                        days_out: Math.max(
                            0,
                            Math.floor((now - new Date(current.startDate)) / DAY_MS)
                        ),
                        overdue: new Date(current.endDate) < now,
                        renter_name: renterName.get(current.userId) || null,
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
