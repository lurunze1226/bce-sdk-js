const http = require('http');
const {URL} = require('url');

// 创建代理服务器
const proxy = http.createServer((clientReq, clientRes) => {
  // 解析客户端请求的目标URL（假设请求路径是完整URL, 如https://bj.bcebos.com）
  const targetUrl = new URL(clientReq.url);
  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || 80, // 默认HTTP端口
    path: targetUrl.pathname + targetUrl.search,
    method: clientReq.method,
    headers: {...clientReq.headers} // 复制原始请求头
  };

  // 打印请求信息
  console.log('\n=== 请求信息（来自客户端） ===');
  console.log(`方法: ${clientReq.method}`);
  console.log(`目标URL: ${clientReq.url}`);
  console.log('请求头:', options.headers);

  // 收集请求体数据
  let requestBody = [];
  clientReq.on('data', (chunk) => {
    requestBody.push(chunk);
  });

  clientReq.on('end', () => {
    if (requestBody.length > 0) {
      console.log('请求体:', Buffer.concat(requestBody).toString());
    }
  });

  // 创建到目标服务器的请求
  const proxyReq = http.request(options, (proxyRes) => {
    // 打印响应信息
    console.log('\n=== 响应信息（来自目标服务器）===');
    console.log(`状态码: ${proxyRes.statusCode}`);
    console.log('响应头:', proxyRes.headers);

    // 收集响应体数据
    let responseBody = [];
    proxyRes.on('data', (chunk) => {
      responseBody.push(chunk);
      clientRes.write(chunk); // 实时转发给客户端
    });

    proxyRes.on('end', () => {
      if (responseBody.length > 0) {
        const responseRaw = Buffer.concat(responseBody).toString();

        try {
          const jsonify = JSON.parse(responseRaw);
          console.log('响应体:', jsonify);
        } catch (error) {
          console.log('响应体:', responseRaw);
        }
      }
      clientRes.end(); // 结束客户端响应
    });
  });

  // 错误处理
  proxyReq.on('error', (err) => {
    console.error('代理请求失败:', err);
    clientRes.writeHead(500);
    clientRes.end('Proxy Error');
  });

  // 转发客户端请求体到目标服务器
  clientReq.pipe(proxyReq);
});

// 启动代理服务器
proxy.listen(3000, () => {
  console.log('代理服务器运行在 http://localhost:3000');
  console.log('命令行测试: curl -x http://localhost:3000 http://jsonplaceholder.typicode.com/posts/1');
  console.log('API请求测试: node client.js');
});
