const { updateAvatar } = require('../services/profile.service');

exports.setAvatar = async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        const url = req.avatar?.publicUrl;
        if (!url) return res.status(400).json({ error: 'Avatar processing failed' });

        const acc = await updateAvatar(req.user.id, url);
        res.status(200).json({
            message: 'Avatar updated',
            data: { avatar_url: acc.avatar_url }
        });
    } catch (e) {
        next(e);
    }
};
