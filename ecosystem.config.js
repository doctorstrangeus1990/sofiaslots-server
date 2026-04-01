module.exports = {
  apps: [{
    name: 'backend',
    script: './server.js', // <-- Change this to your actual entry file
    user: 'puppeteer-user',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
};