module.exports = {
  app: require('./app.config'),
  database: require('./database.config'),
  jwt: require('./jwt.config'),
  smtp: require('./smtp.config'),
  storage: require('./storage.config'),
  // Redis is accessed via getRedisClient() from redis.config directly
};
