// controllers/gameController.js
const GameAccount = require('../models/GameAccount');
const Game = require('../models/Game');

// Get all available games
const getAllGames = async (req, res) => {
  try {
    const games = await Game.find({ 
      status: { $in: ['active', 'maintenance'] }
    }).sort({ order: 1, name: 1 });

    const gamesList = games.map(game => ({
      _id: game._id,
      title: game.name,
      name: game.name,
      slug: game.slug,
      shortcode: game.shortcode,
      gameType: game.gameType,
      category: game.category,
      status: game.status,
      gameUrl: game.gameUrl,
      downloadUrl: game.downloadUrl,
      image: game.image,
      displayName: game.name,
      rating: game.rating,
      isNew: game.isNew,
      isFeatured: game.isFeatured,
      totalPlayers: game.stats?.totalAccounts || 0
    }));

    res.json({
      success: true,
      message: 'Games retrieved successfully',
      data: gamesList
    });
  } catch (error) {
    console.error('Error fetching games:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching games'
    });
  }
};

// Get single game by slug
const getGameBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    
    const game = await Game.findOne({
      slug,
      status: 'active'
    });
    
    if (!game) {
      return res.status(404).json({
        success: false,
        message: 'Game not found'
      });
    }

    const gameData = {
      _id: game._id,
      title: game.name,
      name: game.name,
      slug: game.slug,
      shortcode: game.shortcode,
      gameType: game.gameType,
      category: game.category,
      status: game.status,
      gameUrl: game.gameUrl,
      downloadUrl: game.downloadUrl,
      image: game.image,
      displayName: game.name,
      rating: game.rating,
      isNew: game.isNew,
      isFeatured: game.isFeatured,
      totalPlayers: game.stats?.totalAccounts || 0
    };

    res.json({
      success: true,
      message: 'Game retrieved successfully',
      data: gameData
    });
  } catch (error) {
    console.error('Error fetching game:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching game'
    });
  }
};

// Get user's game accounts
const getUserGameAccounts = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { gameType } = req.query;
        
    const gameAccounts = await GameAccount.findByUser(userId, gameType);

    const accountsWithBalance = gameAccounts.map(account => ({
      id: account._id,
      gameType: account.gameType,
      gameLogin: account.gameLogin,
      gamePassword: account.gamePassword,
      balance: account.balance,
      status: account.status,
      downloadCode: account.downloadCode,
      lastBalanceCheck: account.lastBalanceCheck,
      createdAt: account.createdAt,
      transactionCount: account.transactions.length
    }));

    res.json({
      success: true,
      message: 'Game accounts retrieved successfully',
      data: { accounts: accountsWithBalance }
    });
  } catch (error) {
    console.error('Error fetching game accounts:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching game accounts'
    });
  }
};

// Helper function to load game controller
const loadGameController = async (slug) => {
  const game = await Game.findOne({ slug, status: 'active' });
  
  if (!game) {
    throw new Error(`Game '${slug}' not found`);
  }

  if (!game.isImplemented()) {
    throw new Error(`${slug} is not yet implemented`);
  }

  const controllerPath = `../gmcontrollers/${game.shortcode.toLowerCase()}Controller.js`;
  const GameController = require(controllerPath);
  
  return { game, controller: GameController };
};

// Create game account - Uses specific game controller
const createGameAccount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug } = req.params;

    const { game, controller } = await loadGameController(slug);

    // Check for existing account
    const existingAccount = await GameAccount.findOne({
      userId,
      gameId: game._id,
      status: 'active'
    });

    if (existingAccount) {
      return res.status(409).json({
        success: false,
        message: 'You already have an active account for this game'
      });
    }

    // Call the controller's createGameAccount method
    const result = await controller.createGameAccount(userId, game);
    
    if (result.success) {
      res.json({
        success: true,
        message: 'Game account created successfully',
        data: {
          accountId: result.data._id,
          gameLogin: result.data.gameLogin,
          gamePassword: result.data.gamePassword,
          gameType: result.data.gameType,
          status: result.data.status
        }
      });
    } else {
      throw new Error(result.message || 'Failed to create game account');
    }
   
  } catch (error) {
    console.error('Error creating game account:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error creating game account'
    });
  }
};

// Get account balance - Uses specific game controller
const getAccountBalance = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    const { game, controller } = await loadGameController(slug);

    // Call the controller's getGameBalance method
    const result = await controller.getGameBalance(userId, gameAccount.gameLogin);

    // Check if the controller returned a successful result
    if (result && result.success) {
      res.json({
        success: true,
        message: 'Balance retrieved successfully',
        data: result.data
      });
    } else {
      // Handle case where controller returns error or no data
      return res.status(500).json({
        success: false,
        message: result?.message || 'Failed to retrieve balance from game server'
      });
    }

  } catch (error) {
    console.error('Error getting balance:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error retrieving balance'
    });
  }
};


const rechargeAccount = async (req, res) => {
  // ✅ IMMEDIATE LOGGING - This should ALWAYS appear if function is called
  console.log('\n');
  console.log('═══════════════════════════════════════════');
  console.log('🚀 RECHARGE ACCOUNT FUNCTION CALLED');
  console.log('Time:', new Date().toISOString());
  console.log('User:', req.user?.userId || 'NO USER');
  console.log('Params:', JSON.stringify(req.params));
  console.log('Body:', JSON.stringify(req.body));
  console.log('═══════════════════════════════════════════');
  
  let transactionId = null;
  let walletTransactionId = null;
  let gameRecharged = false;
  let clientDisconnected = false;

  req.on('close', () => {
    if (!res.headersSent) {
      console.log('⚠️ CLIENT DISCONNECTED');
      clientDisconnected = true;
    }
  });

  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;
    const { amount, remark, isBonus } = req.body;

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📥 RECHARGE REQUEST`);
    console.log(`Amount: $${amount}, isBonus: ${isBonus}`);
    console.log(`Custom Remark: "${remark || 'none'}"`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive whole number'
      });
    }

    if (amount > 1000) {
      return res.status(400).json({
        success: false,
        message: 'Maximum recharge amount is $1000'
      });
    }

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId,
      userId,
      status: 'active'
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    // ✅ ALSO CHECK AND CLEAN WALLET PENDING TRANSACTIONS
    const Wallet = require('../models/Wallet');
    const userWallet = await Wallet.findOne({ userId });
    if (userWallet) {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
      const pendingWalletTxs = userWallet.transactions.filter(
        t => t.type === 'game_deposit' && 
             t.status === 'pending' &&
             t.gameDetails?.gameAccountId?.toString() === accountId.toString()
      );

      if (pendingWalletTxs.length > 0) {
        console.log(`\n🔍 Found ${pendingWalletTxs.length} pending WALLET transaction(s) for this game account`);
        
        for (const walletTx of pendingWalletTxs) {
          const txAge = new Date(walletTx.createdAt);
          const ageInSeconds = Math.floor((Date.now() - txAge.getTime()) / 1000);
          
          if (txAge <= thirtySecondsAgo) {
            console.log(`🔄 Auto-failing OLD wallet transaction (${ageInSeconds}s old):`, walletTx._id);
            
            walletTx.status = 'failed';
            walletTx.metadata = walletTx.metadata || {};
            walletTx.metadata.autoFailed = true;
            walletTx.metadata.failureReason = `Auto-failed - stuck for ${ageInSeconds} seconds`;
            
            // Release pending balance
            if (!walletTx.isBonus) {
              userWallet.pendingBalance = Math.max(0, userWallet.pendingBalance - walletTx.amount);
              console.log(`   ↩️  Released $${walletTx.amount} from pending`);
            } else {
              userWallet.bonusBalance += walletTx.amount;
              console.log(`   ↩️  Refunded $${walletTx.amount} to bonus balance`);
            }
          }
        }
        
        userWallet.updateAvailableBalance();
        await userWallet.save();
        console.log('✅ Old wallet transactions cleaned up\n');
      }
    }

    // ✅ CHECK FOR PENDING GAME TRANSACTIONS
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    const pendingTransactions = gameAccount.transactions.filter(
      t => t.type === 'recharge' && t.status === 'pending'
    );

    if (pendingTransactions.length > 0) {
      console.log(`\n🔍 Found ${pendingTransactions.length} pending transaction(s)`);
      
      let hasRecentPending = false;
      
      for (const pendingTx of pendingTransactions) {
        const txAge = new Date(pendingTx.createdAt);
        const ageInSeconds = Math.floor((Date.now() - txAge.getTime()) / 1000);
        
        console.log(`📋 Checking transaction ${pendingTx._id}:`);
        console.log(`   - Created: ${pendingTx.createdAt}`);
        console.log(`   - Age: ${ageInSeconds} seconds`);
        console.log(`   - Status: ${pendingTx.status}`);
        
        if (txAge > thirtySecondsAgo) {
          // Recent pending (less than 30 seconds old) - BLOCK
          hasRecentPending = true;
          console.log(`   ⚠️ BLOCKING: Too recent (${ageInSeconds}s < 30s)`);
        } else {
          // Old pending (more than 30 seconds old) - MARK AS FAILED
          console.log(`   🔄 AUTO-FAILING: Too old (${ageInSeconds}s >= 30s)`);
          
          pendingTx.status = 'failed';
          pendingTx.metadata = pendingTx.metadata || {};
          pendingTx.metadata.autoFailed = true;
          pendingTx.metadata.failureReason = `Auto-failed - stuck for ${ageInSeconds} seconds`;
          pendingTx.failedAt = new Date();
          
          // Rollback wallet transaction if exists
          if (pendingTx.walletTransactionId) {
            try {
              const userWalletForRollback = await Wallet.findOne({ userId });
              if (userWalletForRollback) {
                const walletTx = userWalletForRollback.transactions.id(pendingTx.walletTransactionId);
                if (walletTx && walletTx.status === 'pending') {
                  walletTx.status = 'failed';
                  walletTx.failedAt = new Date();
                  await userWalletForRollback.save();
                  console.log(`   ✅ Rolled back wallet transaction: ${pendingTx.walletTransactionId}`);
                }
              }
            } catch (err) {
              console.error('   ❌ Failed to rollback wallet transaction:', err);
            }
          }
        }
      }
      
      // Save the failed transactions
      await gameAccount.save();
      
      // If there's a RECENT pending, block the request
      if (hasRecentPending) {
        return res.status(409).json({
          success: false,
          message: 'A recharge is already in progress. Please wait 30 seconds and try again.'
        });
      }
      
      console.log('✅ Old pending transactions marked as failed. Proceeding with new recharge...\n');
    }

    // ✅ LOAD GAME CONTROLLER EARLY - So game.name is available
    console.log(`\n🎮 Loading game controller for slug: "${slug}"...`);
    const { game, controller } = await loadGameController(slug);
    console.log(`✅ Game loaded: ${game.name} (${game.gameType})`);
    
    const isBonusDeposit = isBonus === true;
    const bonusAmount = Math.floor(amount * 0.1);
    const totalAmountToGame = amount + bonusAmount;

    console.log(`\n💰 Calculation:`);
    console.log(`   User amount: $${amount}`);
    console.log(`   Bonus amount: $${bonusAmount}`);
    console.log(`   Total to game: $${totalAmountToGame}`);
    console.log(`   Is bonus deposit: ${isBonusDeposit}`);
    console.log(`   Game name: ${game.name}`);

    // ✅ STEP 1: CHECK WALLET BALANCE FIRST
    console.log('\n💳 Checking wallet balance...');
    const wallet = await Wallet.findOrCreateWallet(userId);
    
    if (isBonusDeposit) {
      if (wallet.availableBonusBalance < amount) {
        return res.status(400).json({
          success: false,
          message: `Insufficient bonus balance. Available: $${wallet.availableBonusBalance.toFixed(2)}`
        });
      }
      console.log(`✅ Bonus balance sufficient: $${wallet.availableBonusBalance} >= $${amount}`);
    } else {
      if (wallet.availableBalance < amount) {
        return res.status(400).json({
          success: false,
          message: `Insufficient balance. Available: $${wallet.availableBalance.toFixed(2)}`
        });
      }
      console.log(`✅ Regular balance sufficient: $${wallet.availableBalance} >= $${amount}`);
    }

    // ✅ STEP 2: CREATE WALLET TRANSACTION (pending) - NOW game.name is available
    console.log('\n💳 Creating wallet transaction (pending)...');
    
    // ✅ ALWAYS INCLUDE GAME NAME - Don't let custom remark override it
    const walletDescription = `Cash In to ${game.name} from ${isBonusDeposit ? 'Bonus Balance' : 'Wallet'}`;
    
    console.log(`📝 Wallet transaction description: "${walletDescription}"`);
    
    const walletTransaction = wallet.addTransaction({
      type: 'game_deposit',
      amount,
      description: walletDescription, // ✅ Always use our format with game name
      status: 'pending',
      isBonus: isBonusDeposit,
      gameDetails: {
        gameType: gameAccount.gameType,
        gameName: game.name, // ✅ Store game name
        gameLogin: gameAccount.gameLogin,
        gameAccountId: gameAccount._id
      },
      referenceId: gameAccount._id,
      metadata: {
        sourceBalance: isBonusDeposit ? 'bonus' : 'regular',
        requestedAt: new Date(),
        gameName: game.name, // ✅ Also in metadata
        customRemark: remark || null // ✅ Store custom remark if provided
      }
    });
    
    await wallet.save();
    walletTransactionId = walletTransaction._id;
    
    console.log(`✅ Wallet transaction created: ${walletTransactionId}`);
    console.log(`   Description saved: "${walletTransaction.description}"`);
    console.log(`   Game name: ${game.name}`);
    console.log(`   Balance locked: ${isBonusDeposit ? 'Bonus' : 'Regular'} $${amount}`);

    // ✅ STEP 3: CREATE GAME TRANSACTION - NOW game.name is available
    console.log('\n📝 Creating game transaction...');
    
    // ✅ ALWAYS INCLUDE GAME NAME
    const gameTransactionRemark = `Deposit $${amount} to ${game.name}${isBonusDeposit ? ' (Bonus)' : ''}`;
    
    console.log(`📝 Game transaction remark: "${gameTransactionRemark}"`);
    
    const gameTransaction = {
      type: 'recharge',
      amount: amount,
      remark: gameTransactionRemark, // ✅ Always include game name
      status: 'pending',
      isBonus: isBonusDeposit,
      walletTransactionId: walletTransactionId,
      metadata: {
        walletSource: isBonusDeposit ? 'bonus' : 'regular',
        walletDeduction: amount,
        gameBonus: bonusAmount,
        totalToGame: totalAmountToGame,
        requestedAt: new Date(),
        gameName: game.name, // ✅ Store game name
        customRemark: remark || null // ✅ Store custom remark if provided
      }
    };

    await gameAccount.addTransaction(gameTransaction);
    transactionId = gameAccount.transactions[gameAccount.transactions.length - 1]._id;

    console.log('✅ Game transaction created:', transactionId);
    console.log(`   Remark: "${gameAccount.transactions[gameAccount.transactions.length - 1].remark}"`);

    if (clientDisconnected) {
      throw new Error('Request cancelled by client');
    }

    // ✅ CALL GAME CONTROLLER WITH TIMEOUT
    console.log('\n🎮 Calling game controller...');
    
    // Use custom remark for actual game recharge if provided, otherwise use our format
    const gameControllerRemark = remark || `Deposit $${amount} to ${game.name}`;
    console.log(`📝 Sending to game controller: "${gameControllerRemark}"`);
    
    const puppeteerPromise = controller.rechargeAccount(
      userId, 
      gameAccount.gameLogin, 
      totalAmountToGame,
      amount,
      gameControllerRemark // Send remark to game (this appears in game history)
    );

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout after 30 seconds')), 30000);
    });

    const result = await Promise.race([puppeteerPromise, timeoutPromise]);

    if (clientDisconnected && result.success) {
      gameRecharged = true;
      const updatedGameAccount = await GameAccount.findById(accountId);
      const recentTransaction = updatedGameAccount.transactions.id(transactionId);
      
      if (recentTransaction) {
        recentTransaction.status = 'completed';
        recentTransaction.completedAt = new Date();
        await updatedGameAccount.save();
      }

      console.log('✅ Completed despite disconnect');
      return;
    }

    if (result.success) {
      gameRecharged = true;

      const updatedGameAccount = await GameAccount.findById(accountId);
      const recentTransaction = updatedGameAccount.transactions.id(transactionId);
      
      if (recentTransaction) {
        recentTransaction.status = 'completed';
        recentTransaction.completedAt = new Date();
        recentTransaction.processedAt = new Date();
        await updatedGameAccount.save();
      }

      // ✅ COMPLETE WALLET TRANSACTION
      const updatedWallet = await Wallet.findOne({ userId });
      updatedWallet.updateTransactionStatus(walletTransactionId, 'completed');
      await updatedWallet.save();

      console.log('✅ Game recharge completed');
      console.log('✅ Wallet transaction completed');
      console.log(`   Final wallet description: "${updatedWallet.transactions.id(walletTransactionId).description}"`);

      return res.json({
        success: true,
        message: `Recharge completed${isBonusDeposit ? ' (Bonus)' : ''}`,
        data: {
          ...result.data,
          transactionId: recentTransaction?._id,
          walletTransactionId: walletTransactionId,
          status: 'completed',
          walletDeduction: amount,
          gameBonus: bonusAmount,
          totalToGame: totalAmountToGame,
          isBonus: isBonusDeposit
        }
      });
    } else {
      throw new Error(result.message || 'Game recharge failed');
    }

  } catch (error) {
    console.error('❌ RECHARGE FAILED:', error.message);
    const failureReason = clientDisconnected ? 'cancelled' : 'failed';

    // ✅ Mark game transaction as failed
    if (transactionId) {
      try {
        const updatedGameAccount = await GameAccount.findById(req.params.accountId);
        const failedTx = updatedGameAccount.transactions.id(transactionId);
        
        if (failedTx) {
          failedTx.status = failureReason;
          failedTx.metadata.failureReason = error.message;
          await updatedGameAccount.save();
        }
      } catch (updateError) {
        console.error('Failed to update game transaction:', updateError);
      }
    }

    // ✅ Rollback wallet transaction
    if (walletTransactionId) {
      try {
        const Wallet = require('../models/Wallet');
        const updatedWallet = await Wallet.findOne({ userId: req.user.userId });
        if (updatedWallet) {
          updatedWallet.updateTransactionStatus(walletTransactionId, failureReason, error.message);
          await updatedWallet.save();
          console.log(`✅ Wallet transaction rolled back: ${walletTransactionId}`);
        }
      } catch (rollbackError) {
        console.error('Failed to rollback wallet transaction:', rollbackError);
      }
    }

    if (!clientDisconnected && !res.headersSent) {
      return res.status(400).json({
        success: false,
        message: error.message || 'Recharge failed',
        status: failureReason
      });
    }
  }
};

const redeemFromAccount = async (req, res) => {
  let transactionId = null;
  let walletTransactionId = null;
  let walletCredited = false;
  let gameRedeemed = false;
  let clientDisconnected = false;

  // ✅ Detect if client disconnects (page refresh/close)
  req.on('close', () => {
    if (!res.headersSent) {
      console.log('⚠️ CLIENT DISCONNECTED - Redeem request aborted');
      clientDisconnected = true;
    }
  });

  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;
    const { amount, remark } = req.body;

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💵 REDEEM REQUEST RECEIVED`);
    console.log(`User: ${userId}`);
    console.log(`Account: ${accountId}`);
    console.log(`Requested Amount: $${amount}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // ✅ Validate integer
    if (!amount || amount <= 0 || !Number.isInteger(amount)) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive whole number'
      });
    }

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId,
      userId
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    // ✅ CHECK FOR EXISTING PENDING REDEEM TRANSACTIONS
    const existingPending = gameAccount.transactions.find(
      t => t.type === 'redeem' && t.status === 'pending'
    );

    if (existingPending) {
      console.log('⚠️ Found existing pending redeem transaction:', existingPending._id);
      return res.status(409).json({
        success: false,
        message: 'A cashout is already in progress. Please wait or refresh.',
        pendingTransactionId: existingPending._id
      });
    }

    const lastDeposit = gameAccount.getLastDeposit();
    
    if (!lastDeposit) {
      return res.status(400).json({
        success: false,
        message: 'No deposit history found. Please deposit first.'
      });
    }

    const CashoutRule = require('../models/CashoutRule');
    const rule = await CashoutRule.findApplicableRule(lastDeposit.amount);

    if (!rule) {
      return res.status(400).json({
        success: false,
        message: `No cashout rule found for deposit $${lastDeposit.amount}`
      });
    }

    if (amount < rule.cashoutLimits.min) {
      return res.status(400).json({
        success: false,
        message: `Minimum cashout is $${rule.cashoutLimits.min} for your deposit of $${lastDeposit.amount}`
      });
    }

    if (amount > rule.cashoutLimits.max) {
      return res.status(400).json({
        success: false,
        message: `Maximum cashout is $${rule.cashoutLimits.max} for your deposit of $${lastDeposit.amount}`
      });
    }

    // ✅ Get fresh balance from game
    const { game, controller } = await loadGameController(slug);
    
    console.log('\n🔍 Step 1: Checking current game balance...');
    const balanceCheck = await controller.getGameBalance(userId, gameAccount.gameLogin);
    
    if (!balanceCheck.success) {
      throw new Error('Failed to fetch current game balance');
    }

    const currentGameBalance = Math.floor(balanceCheck.data.balance);
    console.log(`Current game balance: $${currentGameBalance}`);
    
    if (amount > currentGameBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available: $${currentGameBalance}`
      });
    }

    const totalGameBalance = currentGameBalance;
    const voidedAmount = totalGameBalance - amount;
    
    // ✅ Calculate wallet transfer amount
    const walletTransferAmount = lastDeposit.isBonus 
      ? Math.floor(amount * 0.10)
      : amount;
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`💵 CASHOUT CALCULATION`);
    console.log(`Requested Cashout: $${amount}`);
    console.log(`Total Game Balance: $${totalGameBalance}`);
    console.log(`Will Void: $${voidedAmount}`);
    console.log(`Last Deposit: $${lastDeposit.amount} (Bonus: ${lastDeposit.isBonus ? 'YES' : 'NO'})`);
    console.log(`Wallet Will Receive: $${walletTransferAmount} (${lastDeposit.isBonus ? '10%' : '100%'})`);
    console.log(`Cashout Limits: $${rule.cashoutLimits.min}-$${rule.cashoutLimits.max}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // ✅ STEP 2: CREATE GAME TRANSACTION (PENDING)
    console.log('\n📝 Step 2: Creating game transaction...');
    
    const gameTransaction = {
      type: 'redeem',
      amount: amount,
      remark: remark || `Cashout $${amount}`,
      status: 'pending',
      isBonus: lastDeposit.isBonus,
      metadata: {
        totalGameBalance: totalGameBalance,
        requestedCashout: amount,
        voidedAmount: voidedAmount,
        walletTransferAmount: walletTransferAmount,
        transferPercentage: lastDeposit.isBonus ? 10 : 100,
        lastDepositAmount: lastDeposit.amount,
        lastDepositWasBonus: lastDeposit.isBonus
      }
    };

    await gameAccount.addTransaction(gameTransaction);
    transactionId = gameAccount.transactions[gameAccount.transactions.length - 1]._id;
    
    console.log('✅ Game transaction created:', transactionId);

    // ✅ CHECK IF CLIENT DISCONNECTED
    if (clientDisconnected) {
      console.log('🚫 Client disconnected after game transaction creation');
      throw new Error('Request cancelled by client');
    }

    // ✅ STEP 3: CALL GAME CONTROLLER (PUPPETEER) WITH TIMEOUT
    console.log('\n🎮 Step 3: Calling game controller to redeem...');
    
    const puppeteerPromise = controller.redeemFromAccount(
      userId, 
      gameAccount.gameLogin, 
      totalGameBalance,
      amount,
      remark || `Cashout $${amount}`
    );

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Game redeem timeout after 30 seconds')), 30000);
    });

    const result = await Promise.race([puppeteerPromise, timeoutPromise]);

    // ✅ CHECK IF CLIENT DISCONNECTED DURING PUPPETEER
    if (clientDisconnected) {
      console.log('⚠️ Client disconnected during Puppeteer operation');
      
      if (result.success) {
        // Game was redeemed but client disconnected
        gameRedeemed = true;
        
        // Continue with wallet credit even though client is gone
        console.log('🔄 Proceeding to credit wallet despite disconnect...');
      } else {
        throw new Error('Client disconnected and game redeem failed');
      }
    }

    if (result.success) {
      gameRedeemed = true;

      // ✅ STEP 4: CREDIT WALLET (ONLY IF GAME REDEEM SUCCEEDED)
      console.log('\n💰 Step 4: Crediting wallet...');
      
      const Wallet = require('../models/Wallet');
      const userWallet = await Wallet.findOne({ userId });

      if (!userWallet) {
        throw new Error('Wallet not found');
      }

      // Create wallet transaction (game_withdrawal adds to balance)
      const walletTransaction = userWallet.addTransaction({
        type: 'game_withdrawal',
        amount: walletTransferAmount,
        description: `Cashout from ${game.name}${lastDeposit.isBonus ? ' (10% restriction)' : ''}`,
        status: 'completed', // ✅ Immediately completed since game already redeemed
        isBonus: false, // Always goes to regular balance
        gameDetails: {
          gameType: game.gameType,
          gameAccountId: accountId,
          gameLogin: gameAccount.gameLogin
        },
        metadata: {
          gameRedeemedAmount: totalGameBalance,
          requestedCashout: amount,
          voidedAmount: voidedAmount,
          fundedByBonus: lastDeposit.isBonus,
          transferPercentage: lastDeposit.isBonus ? 10 : 100
        }
      });

      await userWallet.save();
      walletTransactionId = walletTransaction._id;
      walletCredited = true;

      console.log('✅ Wallet credited:', walletTransactionId);
      console.log(`   Wallet balance: $${userWallet.balance}`);

      // ✅ STEP 5: MARK GAME TRANSACTION AS COMPLETED
      const updatedGameAccount = await GameAccount.findById(accountId);
      const recentTransaction = updatedGameAccount.transactions.id(transactionId);
      
      if (recentTransaction) {
        recentTransaction.status = 'completed';
        recentTransaction.completedAt = new Date();
        recentTransaction.processedAt = new Date();
        recentTransaction.walletTransactionId = walletTransactionId;
        
        if (clientDisconnected) {
          recentTransaction.metadata.completedDespiteDisconnect = true;
        }
        
        await updatedGameAccount.save();
      }

      console.log('✅ Cashout completed successfully');

      // Only send response if client is still connected
      if (!clientDisconnected && !res.headersSent) {
        return res.json({
          success: true,
          message: `Cashout completed successfully${lastDeposit.isBonus ? ' (10% restriction applied)' : ''}`,
          data: {
            ...result.data,
            transactionId: recentTransaction?._id,
            walletTransactionId: walletTransactionId,
            status: 'completed',
            totalRedeemedFromGame: totalGameBalance,
            requestedCashout: amount,
            voidedAmount: voidedAmount,
            walletTransferAmount: walletTransferAmount,
            wasFundedByBonus: lastDeposit.isBonus,
            transferPercentage: lastDeposit.isBonus ? 10 : 100
          }
        });
      }
    } else {
      throw new Error(result.message || 'Redeem failed');
    }

  } catch (error) {
    console.error('❌ REDEEM FAILED:', error.message);

    const failureReason = clientDisconnected ? 'cancelled' : 'failed';

    // ✅ ROLLBACK LOGIC
    // Note: For redeem, we DON'T refund wallet because:
    // 1. Game redeem happens BEFORE wallet credit
    // 2. If game redeem fails, nothing was taken from wallet yet
    // 3. If game redeem succeeds, wallet should be credited (even if client disconnected)

    if (gameRedeemed && !walletCredited) {
      // ⚠️ CRITICAL SITUATION: Game was redeemed but wallet credit failed
      console.error('🚨 CRITICAL: Game redeemed but wallet credit failed!');
      console.error('   Manual intervention required - user balance voided from game');
      
      // TODO: Log to monitoring system, create manual review ticket
      // For now, mark transaction as needing review
      try {
        const updatedGameAccount = await GameAccount.findById(req.params.accountId);
        const failedTx = updatedGameAccount.transactions.id(transactionId);
        
        if (failedTx) {
          failedTx.status = 'requires_review';
          failedTx.metadata.criticalError = true;
          failedTx.metadata.errorReason = 'Game redeemed but wallet credit failed';
          failedTx.metadata.gameRedeemedSuccessfully = true;
          await updatedGameAccount.save();
        }
      } catch (updateError) {
        console.error('Failed to update transaction for review:', updateError);
      }
    }

    // ✅ Mark game transaction as failed/cancelled (if no wallet credit happened)
    if (transactionId && !walletCredited) {
      try {
        const updatedGameAccount = await GameAccount.findById(req.params.accountId);
        const failedTx = updatedGameAccount.transactions.id(transactionId);
        
        if (failedTx) {
          failedTx.status = failureReason;
          failedTx.metadata.failureReason = error.message;
          failedTx.metadata.failureType = failureReason;
          failedTx[`${failureReason}At`] = new Date();
          await updatedGameAccount.save();
          
          console.log(`✅ Game transaction marked as ${failureReason}`);
        }
      } catch (updateError) {
        console.error('Failed to update game transaction status:', updateError);
      }
    }

    // Only send response if client is still connected
    if (!clientDisconnected && !res.headersSent) {
      return res.status(400).json({
        success: false,
        message: error.message || 'Cashout failed',
        status: failureReason,
        requiresReview: gameRedeemed && !walletCredited
      });
    }
  }
};

const getCashoutInfo = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    // ✅ Get last deposit
    const lastDeposit = gameAccount.getLastDeposit();
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 CASHOUT INFO DEBUG`);
    console.log(`Game Account: ${gameAccount.gameLogin}`);
    console.log(`Account ID: ${accountId}`);
    console.log(`Current Balance: $${gameAccount.balance}`);
    console.log(`\n🔍 LAST DEPOSIT DETAILS:`);
    if (lastDeposit) {
      console.log(`   Amount: $${lastDeposit.amount}`);
      console.log(`   Date: ${lastDeposit.date}`);
      console.log(`   isBonus: ${lastDeposit.isBonus}`);
      console.log(`   Transaction ID: ${lastDeposit.transactionId}`);
      console.log(`   Wallet Transaction ID: ${lastDeposit.walletTransactionId}`);
    } else {
      console.log(`   ❌ NO DEPOSIT FOUND`);
    }
    
    console.log(`\n📜 ALL RECHARGE TRANSACTIONS:`);
    const allRecharges = gameAccount.transactions
      .filter(t => t.type === 'recharge')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    
    allRecharges.forEach((t, index) => {
      console.log(`   ${index + 1}. ID: ${t._id}`);
      console.log(`      Amount: $${t.amount}`);
      console.log(`      Status: ${t.status}`);
      console.log(`      isBonus: ${t.isBonus}`);
      console.log(`      Created: ${t.createdAt}`);
      console.log(`      Wallet Tx: ${t.walletTransactionId || 'none'}`);
      console.log(`      Metadata:`, t.metadata);
      console.log(`      ---`);
    });
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    
    if (!lastDeposit) {
      return res.status(400).json({
        success: false,
        message: 'No deposit history found. Please deposit first.'
      });
    }

    // Find applicable cashout rule
    const CashoutRule = require('../models/CashoutRule');
    const rule = await CashoutRule.findApplicableRule(lastDeposit.amount);

    if (!rule) {
      return res.status(404).json({
        success: false,
        message: `No cashout rule found for deposit amount $${lastDeposit.amount}`
      });
    }

    console.log(`✅ Cashout Rule Found:`);
    console.log(`   Min: $${rule.cashoutLimits.min}`);
    console.log(`   Max: $${rule.cashoutLimits.max}`);
    console.log(`   Bonus Restriction Applies: ${lastDeposit.isBonus}`);

    res.json({
      success: true,
      data: {
        lastDeposit: lastDeposit.amount,
        isBonus: lastDeposit.isBonus,
        depositDate: lastDeposit.date,
        cashoutLimits: rule.cashoutLimits,
        currentBalance: gameAccount.balance,
        bonusRestrictionApplies: lastDeposit.isBonus,
        expectedCashoutPercentage: lastDeposit.isBonus ? 10 : 100
      }
    });

  } catch (error) {
    console.error('❌ Error getting cashout info:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving cashout information'
    });
  }
};

// Get download code - Uses specific game controller
// Get download code - Uses specific game controller
const getDownloadCode = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    const { game, controller } = await loadGameController(slug);

    // Call the controller's getDownloadCodeForUser method
    const result = await controller.getDownloadCodeForUser(userId, gameAccount.gameLogin);

    if (result && result.success) {
      res.json({
        success: true,
        message: 'Download code retrieved successfully',
        data: result.data
      });
    } else {
      throw new Error(result?.message || 'Failed to get download code');
    }

  } catch (error) {
    console.error('Error getting download code:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error retrieving download code'
    });
  }
};

// Reset account password - Uses specific game controller
// Reset account password - Uses specific game controller
const resetAccountPassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;

    const generateRandomString = () => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
    };
    
    // ✅ FIXED: Generate 6-16 char password with letters, numbers, and allowed symbols
    // Format: Bc + 6 random chars + 2-3 digits + !
    // Example: "Bca4k2x7943!" (12 chars) - valid!
    const randomChars = generateRandomString() + generateRandomString().substring(0, 2); // 6 chars
    const randomNum = Math.floor(Math.random() * 999) + 1; // 1-999 (1-3 digits)
    const newPassword = `Bc${randomChars}${randomNum}!`;

    console.log(`🔐 Generated password: ${newPassword} (${newPassword.length} chars)`);

    // Validation
    if (!newPassword) {
      return res.status(400).json({
        success: false,
        message: 'New password is required'
      });
    }

    if (newPassword.length < 6 || newPassword.length > 16) {
      return res.status(400).json({
        success: false,
        message: 'Password must be 6-16 characters long'
      });
    }

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    const { game, controller } = await loadGameController(slug);

    // Call the controller's resetAccountPassword method
    const result = await controller.resetAccountPassword(
      userId, 
      gameAccount.gameLogin, 
      newPassword
    );
    
    if (result && result.success) {
      // Update password in database
      gameAccount.gamePassword = newPassword;
      await gameAccount.save();
      
      res.json({
        success: true,
        message: 'Password reset successfully',
        data: {
          gameLogin: gameAccount.gameLogin,
          newPassword: newPassword
        }
      });
    } else {
      throw new Error(result?.message || 'Password reset failed');
    }

  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error resetting password'
    });
  }
};

// Get account transactions
const getAccountTransactions = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { accountId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    // ✅ ADD THIS DEBUG SECTION:
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 GET ACCOUNT TRANSACTIONS DEBUG');
    console.log(`Account ID: ${accountId}`);
    console.log(`User ID: ${userId}`);
    console.log(`Total Transactions in DB: ${gameAccount.transactions.length}`);
    
    // Check for duplicates by ID
    const txIds = gameAccount.transactions.map(t => t._id.toString());
    const uniqueTxIds = new Set(txIds);
    
    if (txIds.length !== uniqueTxIds.size) {
      console.error('🚨 DUPLICATE TRANSACTION IDs IN DATABASE!');
      console.log('Total:', txIds.length);
      console.log('Unique:', uniqueTxIds.size);
    }
    
    console.log('\n🔍 ALL TRANSACTIONS:');
    gameAccount.transactions
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .forEach((t, i) => {
        console.log(`\n  ${i + 1}. Transaction ID: ${t._id}`);
        console.log(`     Type: ${t.type}`);
        console.log(`     Amount: $${t.amount}`);
        console.log(`     Remark: ${t.remark || 'none'}`);
        console.log(`     Status: ${t.status}`);
        console.log(`     isBonus: ${t.isBonus}`);
        console.log(`     Created: ${t.createdAt}`);
        console.log(`     Wallet TX ID: ${t.walletTransactionId || 'none'}`);
        if (t.metadata && Object.keys(t.metadata).length > 0) {
          console.log(`     Metadata:`, t.metadata);
        }
      });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);

    const transactions = gameAccount.transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(startIndex, endIndex);

    const totalTransactions = gameAccount.transactions.length;
    const totalPages = Math.ceil(totalTransactions / limit);

    res.json({
      success: true,
      message: 'Transaction history retrieved successfully',
      data: {
        transactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages,
          totalTransactions,
          hasNextPage: endIndex < totalTransactions,
          hasPrevPage: page > 1
        }
      }
    });

  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching transaction history'
    });
  }
};

// Deactivate account
const deactivateAccount = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    gameAccount.status = 'inactive';
    await gameAccount.save();

    res.json({
      success: true,
      message: 'Game account deactivated successfully'
    });

  } catch (error) {
    console.error('Error deactivating account:', error);
    res.status(500).json({
      success: false,
      message: 'Error deactivating game account'
    });
  }
};

// Start game session
const startGameSession = async (req, res) => {
  try {
    const { slug } = req.params;
    const userId = req.user.userId;

    const { game, controller } = await loadGameController(slug);
    
    const gameAccount = await GameAccount.findOne({ 
      userId, 
      gameId: game._id, 
      status: 'active' 
    });

    if (!gameAccount) {
      return res.status(400).json({
        success: false,
        message: 'No active game account found. Please create an account first.',
        requiresAccount: true
      });
    }

    const sessionData = {
      gameSlug: slug,
      gameType: game.gameType,
      userId,
      gameLogin: gameAccount.gameLogin,
      sessionId: `session_${Date.now()}_${userId}`,
      balance: gameAccount.balance,
      downloadCode: gameAccount.downloadCode,
      accountId: gameAccount._id
    };

    res.json({
      success: true,
      message: 'Game session started',
      data: sessionData
    });

  } catch (error) {
    console.error('Error starting game:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error starting game'
    });
  }
};

// Get account summary - Uses specific game controller
const getAccountSummary = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    const { game, controller } = await loadGameController(slug);

    // Get fresh balance from controller
    const balanceResult = await controller.getGameBalance(userId, gameAccount.gameLogin);

    // Get recent transactions (last 5)
    const transactions = gameAccount.transactions
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    // Calculate transaction summaries
    const totalRecharges = gameAccount.transactions
      .filter(t => t.type === 'recharge' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);
    
    const totalRedeems = gameAccount.transactions
      .filter(t => t.type === 'redeem' && t.status === 'completed')
      .reduce((sum, t) => sum + t.amount, 0);

    res.json({
      success: true,
      message: 'Account summary retrieved successfully',
      data: {
        balance: balanceResult.data,
        recentTransactions: transactions,
        summary: {
          totalRecharges,
          totalRedeems,
          netAmount: totalRecharges - totalRedeems,
          transactionCount: gameAccount.transactions.length
        }
      }
    });

  } catch (error) {
    console.error('Error getting account summary:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error retrieving account summary'
    });
  }
};

// Refresh account balance - Uses specific game controller
const refreshAccountBalance = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { slug, accountId } = req.params;

    const gameAccount = await GameAccount.findOne({ 
      _id: accountId, 
      userId 
    });

    if (!gameAccount) {
      return res.status(404).json({
        success: false,
        message: 'Game account not found'
      });
    }

    const { game, controller } = await loadGameController(slug);

    // Get fresh balance from controller - pass userId and gameLogin
    const result = await controller.getGameBalance(userId, gameAccount.gameLogin);

    res.json({
      success: true,
      message: 'Balance refreshed successfully',
      data: result.data
    });

  } catch (error) {
    console.error('Error refreshing balance:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Error refreshing balance'
    });
  }
};

module.exports = {
  getAllGames,
  getGameBySlug,
  getUserGameAccounts,
  createGameAccount,
  getAccountBalance,
  rechargeAccount,
  redeemFromAccount,
  getCashoutInfo,
  getDownloadCode,
  getAccountTransactions,
  resetAccountPassword,
  deactivateAccount,
  startGameSession,
  getAccountSummary,
  refreshAccountBalance
};