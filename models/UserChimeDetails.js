// models/UserChimeDetails.js
const mongoose = require('mongoose');

const userChimeDetailsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    chimeTag: {
        type: String,
        trim: true,
        validate: {
            validator: function(v) {
                return !v || /^\$[a-zA-Z0-9_-]+$/.test(v);
            },
            message: props => `${props.value} is not a valid $ChimeSign format!`
        }
    },
    fullName: {
        type: String,
        trim: true,
        required: true
    },
    isActive: {
        type: Boolean,
        default: true
    },
    lastVerified: Date
}, {
    timestamps: true
});

// Index for efficient queries
userChimeDetailsSchema.index({ userId: 1 });
userChimeDetailsSchema.index({ chimeTag: 1 });

// Static method to find or create user chime details
userChimeDetailsSchema.statics.findOrCreate = async function(userId, data) {
    let userDetails = await this.findOne({ userId });
    
    if (!userDetails) {
        userDetails = new this({
            userId,
            ...data
        });
    } else {
        Object.assign(userDetails, data);
        userDetails.updatedAt = new Date();
    }
    
    await userDetails.save();
    return userDetails;
};

module.exports = mongoose.model('UserChimeDetails', userChimeDetailsSchema);