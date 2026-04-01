// controllers/gameControllerFactory.js
const Game = require('../models/Game');
const path = require('path');
const fs = require('fs');

class GameControllerFactory {
  constructor() {
    this.controllerCache = new Map();
  }
    
  // Dynamically load controller based on game shortcode
  async getController(gameId) {
    try {
      // Check cache first
      if (this.controllerCache.has(gameId)) {
        return this.controllerCache.get(gameId);
      }

      // Get game from database
      const game = await Game.findById(gameId);
      if (!game) {
        throw new Error(`Game with ID '${gameId}' not found`);
      }

      if (!game.implementation.isImplemented || !game.shortcode) {
        throw new Error(`Controller for game '${game.name}' is not implemented`);
      }

      // Build controller file path based on shortcode
      const controllerFileName = `${game.shortcode.toLowerCase()}Controller.js`;
      const controllerPath = path.join(__dirname, controllerFileName);

      // Check if controller file exists
      if (!fs.existsSync(controllerPath)) {
        throw new Error(`Controller file '${controllerFileName}' not found for game '${game.name}'`);
      }

      // Dynamically require the controller
      const Controller = require(`./${controllerFileName}`);
      
      // Cache the controller
      this.controllerCache.set(gameId, Controller);
      
      return Controller;
    } catch (error) {
      throw new Error(`Failed to load controller: ${error.message}`);
    }
  }

  // Alternative method to get controller by shortcode directly
  async getControllerByShortcode(shortcode) {
    try {
      const game = await Game.findOne({ shortcode: shortcode.toUpperCase() });
      if (!game) {
        throw new Error(`Game with shortcode '${shortcode}' not found`);
      }
      
      return this.getController(game._id);
    } catch (error) {
      throw new Error(`Failed to load controller by shortcode: ${error.message}`);
    }
  }

  // Check if controller is implemented for a game
  async isImplemented(gameId) {
    try {
      const game = await Game.findById(gameId);
      if (!game) return false;
      
      return game.implementation.isImplemented && !!game.shortcode;
    } catch (error) {
      console.error('Error checking implementation:', error);
      return false;
    }
  }

  // Get all available games from database
  async getSupportedGames() {
    try {
      const games = await Game.find({ 
        'adminSettings.isEnabled': true,
        status: { $in: ['active', 'maintenance'] } 
      }).sort({ 'display.order': 1, name: 1 });
      
      const gamesList = {};
      
      for (const game of games) {
        gamesList[game.slug] = {
          id: game._id,
          title: game.name,
          slug: game.slug,
          shortcode: game.shortcode,
          gameType: game.gameType,
          category: game.category,
          description: game.description,
          status: game.status,
          settings: game.settings,
          features: game.features,
          gameUrl: game.gameUrl,
          downloadUrl: game.downloadUrl,
          display: game.display,
          implementation: game.implementation
        };
      }
      
      return gamesList;
    } catch (error) {
      console.error('Error fetching games from database:', error);
      return {};
    }
  }

  // Get only active games
  async getActiveGames() {
    try {
      const games = await Game.find({ 
        'adminSettings.isEnabled': true,
        status: 'active' 
      }).sort({ 'display.order': 1, name: 1 });
      
      const gamesList = {};
      
      for (const game of games) {
        gamesList[game.slug] = {
          id: game._id,
          title: game.name,
          slug: game.slug,
          shortcode: game.shortcode,
          gameType: game.gameType,
          category: game.category,
          description: game.description,
          status: game.status,
          settings: game.settings,
          features: game.features,
          gameUrl: game.gameUrl,
          downloadUrl: game.downloadUrl,
          display: game.display,
          implementation: game.implementation
        };
      }
      
      return gamesList;
    } catch (error) {
      console.error('Error fetching active games:', error);
      return {};
    }
  }

  // Get game by slug from database
  async getGameBySlug(slug) {
    try {
      const game = await Game.findOne({ 
        slug, 
        'adminSettings.isEnabled': true 
      });
      
      if (!game) return null;
      
      return {
        id: game._id,
        title: game.name,
        slug: game.slug,
        shortcode: game.shortcode,
        gameType: game.gameType,
        category: game.category,
        description: game.description,
        status: game.status,
        settings: game.settings,
        features: game.features,
        gameUrl: game.gameUrl,
        downloadUrl: game.downloadUrl,
        display: game.display,
        implementation: game.implementation
      };
    } catch (error) {
      console.error('Error fetching game by slug:', error);
      return null;
    }
  }

  // Clear controller cache (useful for development)
  clearCache() {
    this.controllerCache.clear();
  }

  // Get cached controllers info
  getCacheInfo() {
    return {
      size: this.controllerCache.size,
      keys: Array.from(this.controllerCache.keys())
    };
  }
}

module.exports = new GameControllerFactory();