const config = require('../config');
const BosClient = require('../../').BosClient;

(async function () {
  const client = new BosClient({
    ...config['bos_qa'],
    proxy: {
      host: '127.0.0.1',
      port: 3000
    }
  });

  console.log('\n=== 代理配置 ===');
  console.log(client.config.proxy);

  try {
    const response = await client.listBuckets();
    const result = {};

    /** 接些response中的Buffer类型，转化为JSON格式 */
    Object.keys(response).forEach((key) => {
      if (Buffer.isBuffer(response[key])) {
        const buffer = Buffer.from(response[key], 'hex').toString('utf-8');
        let bodyJson;

        try {
          bodyJson = JSON.parse(buffer);
        } catch (error) {
          bodyJson = buffer;
        }

        result[key] = bodyJson;
      } else {
        result[key] = response[key];
      }
    });

    // 打印响应信息
    console.log('\n=== 响应信息（来自代理服务器） ===');
    console.log(result);
  } catch (error) {
    console.log('代理请求失败: \n', error);
  }
})();
