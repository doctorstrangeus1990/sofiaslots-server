// middleware/adminMiddleware.js - UPDATED TO SUPPORT STAFF

const adminMiddleware = (req, res, next) => {
  try {
    // Check if user exists
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // ✅ Allow both Admin (role 1) and Staff (role 3)
    if (![1, 3].includes(req.user.userRole)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Admin or Staff privileges required.'
      });
    }

    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({
      success: false,
      message: 'Error validating admin privileges'
    });
  }
};

module.exports = adminMiddleware;