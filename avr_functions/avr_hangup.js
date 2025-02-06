const axios = require('axios');

module.exports = async function (args) {
  console.log("Hangup call with args:", args);
  const url = process.env.AMI_URL || 'http://127.0.0.1:6006';

  return await axios.post(`${url}/hangup`, { uuid: args.uuid });
};