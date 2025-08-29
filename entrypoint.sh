#!/bin/sh

# Ensure the data directory exists
mkdir -p /usr/src/app/data

# Create the database file if it doesn't exist
touch /usr/src/app/data/standup.db

# Set the correct ownership
chown -R node:node /usr/src/app/data

# Execute the main command
exec "$@"
