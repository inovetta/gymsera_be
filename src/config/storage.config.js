module.exports = {
  driver: process.env.STORAGE_DRIVER || 'local',
  aws: {
    region: process.env.AWS_REGION || '',
    accessKey: process.env.AWS_ACCESS_KEY || '',
    secretKey: process.env.AWS_SECRET_KEY || '',
    bucket: process.env.AWS_BUCKET || '',
  },
};
