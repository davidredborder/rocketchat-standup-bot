FROM node:20

WORKDIR /usr/src/app

COPY package*.json ./

# The official node:20 image is Debian-based and has build-essential pre-installed.
# This is sufficient for building sqlite3.
RUN npm install

COPY . .

RUN chmod +x entrypoint.sh

# The .env file should be mounted as a volume at runtime.

ENTRYPOINT [ "./entrypoint.sh" ]
CMD [ "node", "src/index.js" ]