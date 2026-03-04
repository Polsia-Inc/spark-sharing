// Protect routes - require authentication
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }

  // For API routes, return JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // For HTML pages, redirect to login
  res.redirect('/admin/login');
}

// Optional auth - set user if logged in, but don't require it
async function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth
};
