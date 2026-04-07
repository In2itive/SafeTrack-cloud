#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "🚀 Starting deployment for SafeTrack Vault System..."

echo "📦 Installing dependencies..."
npm install

echo "🏗️ Building the application..."
npm run build

echo "🔄 Restarting Node.js server via PM2..."

# Check if pm2 is installed globally, if not, recommend installing it
if ! command -v pm2 &> /dev/null
then
    echo "pm2 could not be found. Installing pm2 globally..."
    npm install -g pm2
fi

# Check if the app is already running in pm2
if pm2 describe safetrack > /dev/null 2>&1; then
    echo "Restarting existing PM2 process..."
    pm2 restart safetrack
else
    echo "Starting new PM2 process..."
    pm2 start npm --name "safetrack" -- start
fi

echo "💾 Saving PM2 process list to resurrect on reboot..."
pm2 save

echo "✅ Deployment complete! The app is now running on port 3000."
