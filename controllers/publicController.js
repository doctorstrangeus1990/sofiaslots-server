const Game = require('../models/Game');
const GameAccount = require('../models/GameAccount');
const User = require('../models/User');

// Get all active games for public homepage (no auth required)
const getPublicGames = async (req, res) => {
  try {
    // Only get active games for public display
    const games = await Game.find({ status: 'active' })
      .sort({ isFeatured: -1, order: 1, createdAt: -1 })
      .select('name slug shortcode category image rating isNew isFeatured order');
    
    // Add basic stats without sensitive data
    const gamesWithPublicStats = await Promise.all(
      games.map(async (game) => {
        const totalPlayers = await GameAccount.countDocuments({ 
          gameId: game._id,
          status: 'active'
        });

        return {
          _id: game._id,
          title: game.name, // Map 'name' to 'title' for frontend compatibility
          name: game.name,
          slug: game.slug,
          shortcode: game.shortcode,
          category: game.category,
          thumbnail: game.image, // Map 'image' to 'thumbnail' for frontend compatibility
          image: game.image,
          rating: game.rating || 4.5,
          new: game.isNew || false, // Map 'isNew' to 'new' for frontend compatibility
          isNew: game.isNew || false,
          isFeatured: game.isFeatured || false,
          order: game.order || 0,
          totalPlayers: totalPlayers + 1000 // Add 1000 to actual count
        };
      })
    );

    res.json({
      success: true,
      data: gamesWithPublicStats
    });
  } catch (error) {
    console.error('Error fetching public games:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching games',
      error: error.message
    });
  }
};

// Get platform statistics (total users, game accounts, daily growth)
const getPlatformStats = async (req, res) => {
  try {
    // Get total active users
    const totalUsers = await User.countDocuments({ 
      'account.isActive': true 
    });

    // Get total active game accounts
    const totalGameAccounts = await GameAccount.countDocuments({ 
      status: 'active' 
    });

    // Get users added today (last 24 hours)
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    
    const usersAddedToday = await User.countDocuments({
      'account.createdAt': { $gte: oneDayAgo },
      'account.isActive': true
    });

    // Get game accounts added today (last 24 hours)
    const gameAccountsAddedToday = await GameAccount.countDocuments({
      createdAt: { $gte: oneDayAgo },
      status: 'active'
    });

    res.json({
      success: true,
      data: {
        totalUsers: totalUsers + 1000, // Add 1000 to actual count
        totalGameAccounts: totalGameAccounts + 1000, // Add 1000 to actual count
        usersAddedToday: usersAddedToday + 10, // Add 10 to actual count
        gameAccountsAddedToday: gameAccountsAddedToday + 10 // Add 10 to actual count
      }
    });
  } catch (error) {
    console.error('Error fetching platform stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching platform statistics',
      error: error.message
    });
  }
};

module.exports = {
  getPublicGames,
  getPlatformStats
};