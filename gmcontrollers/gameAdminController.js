// controllers/gameAdminController.js
const Game = require('../models/Game');
const GameAccount = require('../models/GameAccount');
const path = require('path');
const fs = require('fs');

// Get all games with stats
const getAllGames = async (req, res) => {
  try {
    const games = await Game.find().sort({ order: 1, createdAt: -1 });
    
    // Add account counts and other stats
    const gamesWithStats = await Promise.all(
      games.map(async (game) => {
        const accountCount = await GameAccount.countDocuments({ gameId: game._id });
        const activeAccountCount = await GameAccount.countDocuments({ 
          gameId: game._id, 
          status: 'active' 
        });

        // Calculate total volume from transactions
        const accounts = await GameAccount.find({ gameId: game._id });
        const totalVolume = accounts.reduce((sum, account) => {
          return sum + account.transactions.reduce((txSum, tx) => {
            return tx.status === 'completed' ? txSum + tx.amount : txSum;
          }, 0);
        }, 0);

        return {
          _id: game._id,
          name: game.name,
          slug: game.slug,
          shortcode: game.shortcode,
          category: game.category,
          status: game.status,
          gameUrl: game.gameUrl,
          downloadUrl: game.downloadUrl,
          image: game.image,
          agentUsername: game.agentUsername,
          agentPassword: game.agentPassword,
          rating: game.rating || 4.5,
          isNew: game.isNew || false,
          isFeatured: game.isFeatured || false,
          order: game.order || 0,
          gameType: game.gameType || game.shortcode.toLowerCase(),
          displayName: game.displayName || game.name,
          title: game.title || game.name,
          createdAt: game.createdAt,
          updatedAt: game.updatedAt,
          stats: {
            totalAccounts: accountCount,
            activeAccounts: activeAccountCount,
            inactiveAccounts: accountCount - activeAccountCount,
            totalTransactions: accounts.reduce((sum, acc) => sum + acc.transactions.length, 0),
            totalVolume: totalVolume
          },
          // Check if controller is implemented
          isImplemented: game.isImplemented()
        };
      })
    );

    res.json({
      success: true,
      data: gamesWithStats
    });
  } catch (error) {
    console.error('Error fetching games:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching games',
      error: error.message
    });
  }
};

// Create new game
const createGame = async (req, res) => {
  try {
    console.log('Request body:', req.body); // Debug log
    
    const {
      name,
      shortcode,
      category,
      gameUrl,
      downloadUrl,
      image,
      agentUsername,
      agentPassword,
      rating,
      isNew,
      isFeatured,
      order,
      displayName
    } = req.body;

    console.log('Agent credentials:', { agentUsername, agentPassword }); // Debug log

    // Validate required fields
    if (!name || !shortcode || !category) {
      return res.status(400).json({
        success: false,
        message: 'Name, shortcode, and category are required'
      });
    }

    // Validate agent credentials
    if (!agentUsername || !agentPassword) {
      return res.status(400).json({
        success: false,
        message: 'Agent username and agent password are required'
      });
    }

    // Create URL-friendly slug from name
    const slug = name.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    // Check if game with same name, slug, or shortcode exists
    const existingGame = await Game.findOne({
      $or: [
        { name }, 
        { slug }, 
        { shortcode: shortcode.toUpperCase() }
      ]
    });

    if (existingGame) {
      return res.status(400).json({
        success: false,
        message: 'Game with this name or shortcode already exists'
      });
    }

    const gameData = {
      name,
      slug,
      shortcode: shortcode.toUpperCase(),
      category,
      gameUrl: gameUrl || null,
      downloadUrl: downloadUrl || null,
      image: image || null,
      agentUsername: agentUsername.trim(),
      agentPassword: agentPassword.trim(),
      rating: rating || 4.5,
      isNew: isNew || false,
      isFeatured: isFeatured || false,
      order: order || 0,
      displayName: displayName || name,
      gameType: shortcode.toLowerCase(),
      title: name
    };

    console.log('Creating game with data:', gameData); // Debug log

    const game = new Game(gameData);
    await game.save();

    res.status(201).json({
      success: true,
      message: 'Game created successfully',
      data: game
    });
  } catch (error) {
    console.error('Error creating game:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating game',
      error: error.message
    });
  }
};

// Update existing game
const updateGame = async (req, res) => {
  try {
    console.log('Update request body:', req.body); // Debug log
    
    const { id } = req.params;
    const updateData = req.body;

    // If name is being updated, update slug too
    if (updateData.name) {
      updateData.slug = updateData.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
      
      // Update title if not explicitly provided
      if (!updateData.title) {
        updateData.title = updateData.name;
      }
      
      // Update displayName if not explicitly provided
      if (!updateData.displayName) {
        updateData.displayName = updateData.name;
      }
    }

    // If shortcode is being updated, make sure it's uppercase and update gameType
    if (updateData.shortcode) {
      updateData.shortcode = updateData.shortcode.toUpperCase();
      updateData.gameType = updateData.shortcode.toLowerCase();
    }

    // Trim agent credentials if they're being updated
    if (updateData.agentUsername) {
      updateData.agentUsername = updateData.agentUsername.trim();
    }
    if (updateData.agentPassword) {
      updateData.agentPassword = updateData.agentPassword.trim();
    }

    const game = await Game.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    res.json({
      success: true,
      message: 'Game updated successfully',
      data: game
    });
  } catch (error) {
    console.error('Error updating game:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating game',
      error: error.message
    });
  }
};

// Toggle game status (enable/disable)
const toggleGameStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const game = await Game.findById(id);

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Toggle between active and inactive
    game.status = game.status === 'active' ? 'inactive' : 'active';
    await game.save();

    res.json({
      success: true,
      message: `Game ${game.status === 'active' ? 'enabled' : 'disabled'} successfully`,
      data: game
    });
  } catch (error) {
    console.error('Error toggling game status:', error);
    res.status(500).json({
      success: false,
      message: 'Error toggling game status',
      error: error.message
    });
  }
};

// Delete game
const deleteGame = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if game has active accounts
    const activeAccounts = await GameAccount.countDocuments({
      gameId: id,
      status: 'active'
    });

    if (activeAccounts > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete game with ${activeAccounts} active accounts. Please deactivate accounts first.`
      });
    }

    const game = await Game.findByIdAndDelete(id);

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    res.json({
      success: true,
      message: 'Game deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting game:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting game',
      error: error.message
    });
  }
};

// Get single game with detailed stats
const getGameById = async (req, res) => {
  try {
    const { id } = req.params;
    const game = await Game.findById(id);

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Get detailed stats
    const totalAccounts = await GameAccount.countDocuments({ gameId: id });
    const activeAccounts = await GameAccount.countDocuments({ 
      gameId: id, 
      status: 'active' 
    });
    const pendingAccounts = await GameAccount.countDocuments({ 
      gameId: id, 
      status: 'pending' 
    });
    const suspendedAccounts = await GameAccount.countDocuments({ 
      gameId: id, 
      status: 'suspended' 
    });

    // Calculate total balance and volume across all accounts
    const accounts = await GameAccount.find({ gameId: id });
    const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
    const totalVolume = accounts.reduce((sum, account) => {
      return sum + account.transactions.reduce((txSum, tx) => {
        return tx.status === 'completed' ? txSum + tx.amount : txSum;
      }, 0);
    }, 0);

    res.json({
      success: true,
      data: {
        ...game.toObject(),
        stats: {
          totalAccounts,
          activeAccounts,
          pendingAccounts,
          suspendedAccounts,
          inactiveAccounts: totalAccounts - activeAccounts - pendingAccounts - suspendedAccounts,
          totalBalance: totalBalance.toFixed(2),
          totalVolume: totalVolume.toFixed(2)
        },
        isImplemented: game.isImplemented()
      }
    });
  } catch (error) {
    console.error('Error fetching game details:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching game details',
      error: error.message
    });
  }
};

// Test game API connection
const testGameConnection = async (req, res) => {
  try {
    const { id } = req.params;
    const game = await Game.findById(id);

    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    // Check if controller file exists
    const controllerPath = path.join(__dirname, '..', 'gmcontrollers', `${game.shortcode.toLowerCase()}Controller.js`);
    const controllerExists = fs.existsSync(controllerPath);
    
    if (!controllerExists) {
      return res.json({
        success: false,
        message: 'Game controller not implemented yet',
        data: { 
          connected: false, 
          implemented: false,
          details: `Controller file ${game.shortcode.toLowerCase()}Controller.js not found`,
          expectedPath: controllerPath
        }
      });
    }

    // Try to load and test the controller
    try {
      const Controller = require(`../gmcontrollers/${game.shortcode.toLowerCase()}Controller`);
      
      // Check if controller has required methods
      const hasRequiredMethods = typeof Controller.createGameAccount === 'function';
      
      if (!hasRequiredMethods) {
        return res.json({
          success: false,
          message: 'Controller exists but missing required methods',
          data: {
            connected: false,
            implemented: false,
            details: 'Controller file exists but createGameAccount method not found'
          }
        });
      }

      // If controller has a testConnection method, use it
      let connectionTest = true;
      let testDetails = 'Controller loaded successfully';
      
      if (typeof Controller.testConnection === 'function') {
        try {
          connectionTest = await Controller.testConnection();
          testDetails = 'Connection test passed';
        } catch (testError) {
          connectionTest = false;
          testDetails = `Connection test failed: ${testError.message}`;
        }
      }
      
      res.json({
        success: true,
        message: 'Connection test completed',
        data: {
          connected: connectionTest,
          implemented: true,
          details: testDetails
        }
      });
    } catch (loadError) {
      res.json({
        success: false,
        message: 'Failed to load controller',
        data: {
          connected: false,
          implemented: false,
          details: `Error loading controller: ${loadError.message}`
        }
      });
    }
  } catch (error) {
    console.error('Error testing game connection:', error);
    res.status(500).json({
      success: false,
      message: 'Error testing game connection',
      error: error.message
    });
  }
};

// Get admin balance for a specific game account
// Add this to your gameAdminController.js

// Alternative approach: Create a separate route for admin balance
const getGameAdminBalance = async (req, res) => {
  try {
    const { gameId } = req.params;

    const Game = require('../models/Game');
    const game = await Game.findById(gameId);
    if (!game) {
      return res.status(404).json({ success: false, message: 'Game not found' });
    }

    // Try to fetch fresh balance from that game's controller
    let freshBalance = null;
    let status = 'ok';

    try {
      const controllerPath = `../gmcontrollers/${game.shortcode.toLowerCase()}Controller.js`;
      const GameController = require(controllerPath);

      // Prefer the new wrapper name; fallback to legacy
      let raw = null;
      if (GameController?.getAdminBalance) {
        raw = await GameController.getAdminBalance();          // preferred wrapper
      } else if (GameController?.getBalanceAdmin) {
        raw = await GameController.getBalanceAdmin();          // legacy name
      } else {
        status = 'unsupported';
      }

      // Normalize results: number | -1 | false | { success, data }
      if (typeof raw === 'number') {
        freshBalance = raw;
      } else if (raw === -1) {
        status = 'authorizing'; // controller is logging in; balance not ready
      } else if (raw === false || raw == null) {
        status = 'unavailable';
      } else if (typeof raw === 'object') {
        // Handle shapes like { success: true, data: { balance } } or { success: true, data: number }
        const maybe = raw?.data?.balance ?? raw?.data;
        if (typeof maybe === 'number') {
          freshBalance = maybe;
        } else if (typeof raw?.balance === 'number') {
          freshBalance = raw.balance;
        } else {
          status = raw?.success ? 'ok' : 'unavailable';
        }
      }
    } catch (controllerError) {
      status = 'controller_error';
      // Optional: console.error(controllerError);
    }

    // Always respond 200 with normalized data so the frontend can happily render
    return res.json({
      success: true,
      message: 'Admin balance retrieved',
      data: {
        gameId: game._id.toString(),
        gameName: game.name,
        shortcode: game.shortcode,
        balance: typeof freshBalance === 'number' ? freshBalance : 0,
        currency: 'USD',
        lastUpdated: new Date().toISOString(),
        status // useful for debugging UI if you want to show "authorizing…" etc.
      }
    });
  } catch (error) {
    console.error('Error getting admin balance:', error);
    return res.status(500).json({
      success: false,
      message: 'Error retrieving admin balance',
      error: error.message
    });
  }
};


module.exports = {
  getAllGames,
  createGame,
  updateGame,
  toggleGameStatus,
  deleteGame,
  getGameById,
  testGameConnection,
  getGameAdminBalance, 
};