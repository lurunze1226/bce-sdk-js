/**
 * Copyright (c) 2014 Baidu.com, Inc. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 * @file src/bos_client.js
 * @author leeight
 */

/* eslint-env node */
/* eslint max-params:[0,10] */

var util = require('util');
var path = require('path');
var fs = require('fs');
var qs = require('querystring');

var u = require('underscore');
var Q = require('q');

var H = require('./headers');
var strings = require('./strings');
var Auth = require('./auth');
var crypto = require('./crypto');
var HttpClient = require('./http_client');
var BceBaseClient = require('./bce_base_client');
var MimeType = require('./mime.types');
var WMStream = require('./wm_stream');
var stream = require('stream');
var Multipart = require('./multipart');
var Base64 = require('./base64');
var {domainUtils} = require('./helper');
var debug = require('debug')('bce-sdk:BosClient');
var SuperUpload = require('./bos/super_upload');

// var MIN_PART_SIZE = 1048576;                // 1M
// var THREAD = 2;
var MAX_PUT_OBJECT_LENGTH = 5368709120; // 5G
var MAX_USER_METADATA_SIZE = 2048; // 2 * 1024
var MIN_PART_NUMBER = 1;
var MAX_PART_NUMBER = 10000;
var MAX_RETRY_COUNT = 3;
var COMMAND_MAP = {
  scale: 's',
  width: 'w',
  height: 'h',
  quality: 'q',
  format: 'f',
  angle: 'a',
  display: 'd',
  limit: 'l',
  crop: 'c',
  offsetX: 'x',
  offsetY: 'y',
  watermark: 'wm',
  key: 'k',
  gravity: 'g',
  gravityX: 'x',
  gravityY: 'y',
  opacity: 'o',
  text: 't',
  fontSize: 'sz',
  fontFamily: 'ff',
  fontColor: 'fc',
  fontStyle: 'fs'
};
var IMAGE_DOMAIN = 'bceimg.com';

/**
 * @typedef {import('./http_client.js').BceConfig} BceConfig
 */

/**
 * Options操作的配置选项
 *
 * 此类型定义:
 * 1. 包含特定属性 versionId
 * 2. 包含请求头信息，平铺到options对象中
 * 3. 包含Clinet配置信息，平铺到options对象中
 *
 * @typedef {{
 *   versionId?: string,   // 对象版本ID，仅支持getObject、getObjectMetadata、deleteObject、copyObject请求传入
 *   [key: string]: any    // 额外的参数，包含请求头、Clinet配置信息等
 * }} OptionsType
 */

/**
 * BOS service api
 *
 * @see http://gollum.baidu.com/BOS_API#BOS-API文档
 *
 * @constructor
 * @param {BceConfig} config The bos client configuration.
 * @extends {BceBaseClient}
 */

function BosClient(config) {
  BceBaseClient.call(this, config, 'bos', true);

  /**
   * @type {HttpClient}
   */
  this._httpAgent = null;
}
util.inherits(BosClient, BceBaseClient);

// --- B E G I N ---
/**
 * 生成带签名的文件URL
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string=} timestamp 当前ISO时间戳
 * @param {number=} expirationInSeconds 过期时间，单位为秒，默认1800秒
 * @param {Record<string, any>=} headers 额外添加的HTTP请求头，默认为空
 * @param {Record<string, any>=} params 需要额外签名的Query参数，默认为空
 * @param {string[]=} headersToSign 需要额外签名的HTTP请求头，默认为空，默认会对host、content-md5、content-type、content-length进行签名
 * @param {Record<string, any>=} config Client配置信息
 * @returns {string} 带签名的文件URL
 */
BosClient.prototype.generatePresignedUrl = function (
  bucketName,
  key,
  timestamp,
  expirationInSeconds,
  headers,
  params,
  headersToSign,
  config
) {
  config = u.extend({}, this.config, config);
  bucketName = config.cname_enabled ? '' : bucketName;

  var endpoint = config.endpoint;
  var pathStyleEnable = !!domainUtils.isIpHost(endpoint) || config.pathStyleEnable;

  // the endpoint provided in config, don't need to generate it by region
  endpoint = domainUtils.handleEndpoint({
    bucketName,
    endpoint,
    protocol: config.protocol,
    cname_enabled: config.cname_enabled,
    pathStyleEnable,
    customGenerateUrl: config.customGenerateUrl
  });

  params = params || {};

  var resource = path
    .normalize(
      path.join(
        config.removeVersionPrefix ? '/' : '/v1',
        !pathStyleEnable ? '' : strings.normalize(bucketName || ''),
        strings.normalize(key || '', false)
      )
    )
    .replace(/\\/g, '/');

  headers = headers || {};
  headers.Host = require('url').parse(endpoint).host;

  var credentials = config.credentials;
  var auth = new Auth(credentials.ak, credentials.sk);

  if (config.sessionToken) {
    params['x-bce-security-token'] = config.sessionToken;
  }

  // Generate the authorization string and return the signed url.
  var authorization = auth.generateAuthorization(
    'GET',
    resource,
    params,
    headers,
    timestamp,
    expirationInSeconds,
    headersToSign
  );

  params.authorization = authorization;

  return util.format('%s%s?%s', endpoint, resource, qs.encode(params));
};

/**
 * 生成不带签名的文件URL，适用于公共读权限的文件
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string|Object[]=} pipeline 图片处理指令，默认为空
 * @returns {string} 文件URL
 */
BosClient.prototype.generateUrl = function (bucketName, key, pipeline, cdn, config) {
  config = u.extend({}, this.config, config);
  bucketName = config.cname_enabled ? '' : bucketName;

  var resource = path
    .normalize(
      path.join(
        config.removeVersionPrefix ? '/' : '/v1',
        strings.normalize(bucketName || ''),
        strings.normalize(key || '', false)
      )
    )
    .replace(/\\/g, '/');

  // pipeline表示如何对图片进行处理.
  var command = '';
  if (pipeline) {
    if (u.isString(pipeline)) {
      if (/^@/.test(pipeline)) {
        command = pipeline;
      } else {
        command = '@' + pipeline;
      }
    } else {
      command =
        '@' +
        u
          .map(pipeline, function (params) {
            return u
              .map(params, function (value, key) {
                return [COMMAND_MAP[key] || key, value].join('_');
              })
              .join(',');
          })
          .join('|');
    }
  }
  if (command) {
    // 需要生成图片转码url
    if (cdn) {
      return util.format('http://%s/%s%s', cdn, path.normalize(key), command);
    }
    return util.format('http://%s.%s/%s%s', path.normalize(bucketName), IMAGE_DOMAIN, path.normalize(key), command);
  }
  return util.format('%s%s%s', this.config.endpoint, resource, command);
};

BosClient.prototype.listBuckets = function (options) {
  options = options || {};
  return this.sendRequest('GET', {config: options.config});
};

BosClient.prototype.putBucket = BosClient.prototype.createBucket = function (bucketName, options) {
  options = options || {};

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    body: JSON.stringify({
      enableMultiAZ: !!(options.body && options.body.enableMultiAZ)
    }),
    config: options.config
  });
};

// BosClient.prototype.deleteBucketCopyrightProtection =
// BosClient.prototype.getBucketCopyrightProtection =
// BosClient.prototype.putBucketCopyrightProtection =
// BosClient.prototype.deleteBucketCors =
// BosClient.prototype.putBucketCors =
// BosClient.prototype.getBucketCors =
// BosClient.prototype.deleteBucketTrash =
// BosClient.prototype.getBucketTrash =
// BosClient.prototype.putBucketTrash =
/**
 * 设置静态网站托管
 * @doc https://cloud.baidu.com/doc/BOS/s/jkc4fl181
 */
BosClient.prototype.putBucketStaticWebsite = function (bucketName, body, options) {
  options = options || {};
  body = u.pick(body || {}, ['index', 'notFound']);

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (body.index && typeof body.index !== 'string') {
    throw new TypeError('field "index" should be a string.');
  }

  if (body.notFound && typeof body.notFound !== 'string') {
    throw new TypeError('field "notFound" should be a string.');
  }

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {website: ''},
    body: JSON.stringify(body),
    config: options.config
  });
};

/**
 * 获取bucket的静态网站托管信息
 * @doc https://cloud.baidu.com/doc/BOS/s/Xkc4fmkit
 */
BosClient.prototype.getBucketStaticWebsite = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {website: ''},
    config: options.config
  });
};

/**
 * 删除bucket设置的静态网站托管信息，并关闭此bucket的静态网站托管
 * @doc https://cloud.baidu.com/doc/BOS/s/9kc4ftbgn
 */
BosClient.prototype.deleteBucketStaticWebsite = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {website: ''},
    config: options.config
  });
};

/**
 * 开启指定Bucket的加密开关
 * @doc https://cloud.baidu.com/doc/BOS/s/9kc4f9eqx
 */
BosClient.prototype.putBucketEncryption = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});

  if (!options.headers.encryptionAlgorithm) {
    throw new TypeError('encryptionAlgorithm should not be empty.');
  }

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {encryption: ''},
    headers: options.headers,
    config: options.config
  });
};

/**
 * 判断Bucket服务端加密是否打开
 * @doc https://cloud.baidu.com/doc/BOS/s/Zkc4fa6x5
 */
BosClient.prototype.getBucketEncryption = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {encryption: ''},
    config: options.config
  });
};

/**
 * 关闭服务端加密功能
 * @doc https://cloud.baidu.com/doc/BOS/s/ukc4fdis4
 */
BosClient.prototype.deleteBucketEncryption = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = options || {};

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {encryption: ''},
    config: options.config
  });
};

BosClient.prototype.getBucketStorageclass = function (bucketName, options) {
  options = options || {};
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {storageClass: ''},
    config: options.config
  });
};

BosClient.prototype.putBucketStorageclass = function (bucketName, storageClass, options) {
  options = options || {};
  var headers = {};
  headers[H.CONTENT_TYPE] = 'application/json; charset=UTF-8';
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    headers: headers,
    params: {storageClass: ''},
    body: JSON.stringify({storageClass: storageClass}),
    config: options.config
  });
};

/**
 * 创建生命周期管理规则
 * @doc https://cloud.baidu.com/doc/BOS/s/Vkc4f2c1y
 */
BosClient.prototype.putBucketLifecycle = function (bucketName, body, options) {
  options = options || {};
  body = u.pick(body || {}, ['rule']);

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!Array.isArray(body.rule)) {
    throw new TypeError('rule should not an array.');
  }

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {lifecycle: ''},
    body: JSON.stringify(body),
    config: options.config
  });
};

/**
 * 获取定义的生命周期管理规则详细信息
 * @doc https://cloud.baidu.com/doc/BOS/s/skc4f3bs0
 */
BosClient.prototype.getBucketLifecycle = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {lifecycle: ''},
    config: options.config
  });
};

/**
 * 删除定义的生命周期管理规则
 * @doc https://cloud.baidu.com/doc/BOS/s/mkc4f5k1x
 */
BosClient.prototype.deleteBucketLifecycle = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {lifecycle: ''},
    config: options.config
  });
};

/**
 * 开启Bucket的访问日志并指定存放日志的Bucket和访问日志的文件前缀
 * @doc https://cloud.baidu.com/doc/BOS/s/Wkc4ezpiy
 */
BosClient.prototype.putBucketLogging = function (bucketName, body, options) {
  options = options || {};
  body = u.pick(body || {}, ['targetBucket', 'targetPrefix']);

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (body.targetPrefix && typeof body.targetPrefix !== 'string') {
    throw new TypeError('targetPrefix should be a string.');
  }

  if (!body.targetBucket) {
    body.targetBucket = bucketName;
  }

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {logging: ''},
    body: JSON.stringify(body),
    config: options.config
  });
};

/**
 * 获取Bucket的访问日志配置
 * @doc https://cloud.baidu.com/doc/BOS/s/ukc4f0uif
 */
BosClient.prototype.getBucketLogging = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {logging: ''},
    config: options.config
  });
};

/**
 * 关闭Bucket访问日志记录功能
 * @doc https://cloud.baidu.com/doc/BOS/s/qkc4f1p2v
 */
BosClient.prototype.deleteBucketLogging = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {logging: ''},
    config: options.config
  });
};

/**
 * 创建数据同步
 * @doc https://cloud.baidu.com/doc/BOS/s/fkc4evoy4
 */
BosClient.prototype.putBucketReplication = function (bucketName, body, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = options || {};
  body = u.pick(body || {}, ['status', 'resource', 'destination', 'replicateHistory', 'replicateDeletes', 'id']);

  if (!body.id || !body.status || !body.resource || !body.destination || !body.replicateDeletes) {
    throw new TypeError(
      'field "id", "status", "resource", "destination", "replicateHistory", "replicateDeletes" should not be empty.'
    );
  }

  if (!body.destination.bucket) {
    throw new TypeError('target bucket name should not be empty.');
  }

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {replication: '', id: body.id},
    body: JSON.stringify(body),
    config: options.config
  });
};

/**
 * 获取bucket指定id的数据同步信息
 * @doc https://cloud.baidu.com/doc/BOS/s/7kc4ewr1u
 */
BosClient.prototype.getBucketReplication = function (bucketName, id, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (id) {
    throw new TypeError('replication id should not be empty.');
  }

  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {replication: '', id},
    config: options.config
  });
};

/**
 * 获取指定id的数据同步复制的进程状态
 * @doc https://cloud.baidu.com/doc/BOS/s/ekc4eyua6
 */
BosClient.prototype.getBucketReplicationProgress = function (bucketName, id, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (id) {
    throw new TypeError('replication id should not be empty.');
  }

  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {replicationProgress: '', id},
    config: options.config
  });
};

/**
 * 删除对应id的数据同步复制配置
 * @doc https://cloud.baidu.com/doc/BOS/s/dkc4exqvg
 */
BosClient.prototype.deleteBucketReplication = function (bucketName, id, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (id) {
    throw new TypeError('replication id should not be empty.');
  }

  options = options || {};

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {replication: '', id},
    config: options.config
  });
};

/**
 * 获取bucket所有的replication同步规则
 * @doc https://cloud.baidu.com/doc/BOS/s/Vkcoek9t5
 */
BosClient.prototype.listBucketReplication = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {replication: '', list: ''},
    config: options.config
  });
};

/**
 * 获得指定Bucket的Object信息列表。
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/Ekc4epj6m
 * @param {string} bucketName Bucket Name
 * @param {OptionsType} options
 */
BosClient.prototype.listObjects = function (bucketName, options) {
  options = options || {};
  var params = u.extend({maxKeys: 1000}, u.pick(options, 'maxKeys', 'prefix', 'marker', 'delimiter'));

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: params,
    config: options.config
  });
};

/**
 * 用于获得指定Bucket的Object多版本信息列表
 *
 * 示例:
 * ```js
 * const response = await client.listObjectVersions(
 *   bucketName,
 *   {
 *     maxKeys: 1000,
 *     prefix: "demo-folder",
 *     versionIdMarker: "AJyQ0XRhboY%3D&versions="
 *   }
 * );
 * ```
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/Klxudlm8i
 * @param {string} bucketName Bucket Name
 * @param {OptionsType} options
 */
BosClient.prototype.listObjectVersions = function (bucketName, options) {
  options = options || {};
  var params = u.extend(
    {maxKeys: 1000},
    u.pick(options, 'maxKeys', 'prefix', 'marker', 'delimiter', 'versionIdMarker')
  );
  params.versions = '';

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: params,
    config: options.config
  });
};

/**
 * 查看Bucket是否存在和请求者是否有权限访问这个Bucket。当请求返还200 OK时，说明Bucket存在且请求者有权限访问，由于headBucket已被占用，所以用_headBucket来代替。
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/Mkc4eqkiz
 * @param {string} bucketName
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype._headBucket = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('HEAD', {
    bucketName: bucketName,
    config: options.config
  });
};

/**
 * 判断bucket是否存在
 *
 * @param {string} bucketName
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.headBucket = BosClient.prototype.doesBucketExist = function (bucketName, options) {
  options = options || {};

  return this.sendRequest('HEAD', {
    bucketName: bucketName,
    config: options.config
  }).then(
    /* eslint-disable */
    function () {
      return Q(true);
    },
    function (e) {
      if (e && e[H.X_STATUS_CODE] === 403) {
        return Q(true);
      }
      if (e && e[H.X_STATUS_CODE] === 404) {
        return Q(false);
      }
      return Q.reject(e);
    }
    /* eslint-enable */
  );
};

BosClient.prototype.deleteBucket = function (bucketName, options) {
  options = options || {};

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    config: options.config
  });
};

BosClient.prototype.setBucketCannedAcl = function (bucketName, cannedAcl, options) {
  options = options || {};

  var headers = {};
  headers[H.X_BCE_ACL] = cannedAcl;
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    headers: headers,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.putBucketAcl = function (bucketName, acl, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_TYPE] = 'application/json; charset=UTF-8';
  headers[H.X_BCE_ACL] = acl;
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    headers: headers,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.setBucketAcl = function (bucketName, acl, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_TYPE] = 'application/json; charset=UTF-8';
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    body: JSON.stringify({accessControlList: acl}),
    headers: headers,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.getBucketAcl = function (bucketName, options) {
  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.getObjectAcl = function (bucketName, key, options) {
  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    key: key,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.putObjectAcl = function (bucketName, key, acl, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_TYPE] = 'application/json; charset=UTF-8';
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    body: JSON.stringify({accessControlList: acl}),
    headers: headers,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.putObjectCannedAcl = function (bucketName, key, cannedAcl, options) {
  options = options || {};

  var headers = {};
  headers[H.X_BCE_ACL] = cannedAcl;
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    headers: headers,
    params: {acl: ''},
    config: options.config
  });
};

/**
 * 删除某个Object的访问权限
 *
 * @param {string} bucketName 桶名称
 * @param {string} objectName 文件名称
 */
BosClient.prototype.deleteObjectAcl = function (bucketName, objectName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!objectName) {
    throw new TypeError('objectName should not be empty.');
  }

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    key: objectName,
    params: {acl: ''},
    config: options.config
  });
};

BosClient.prototype.getBucketLocation = function (bucketName, options) {
  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {location: ''},
    config: options.config
  });
};

/**
 * 该命令可以实现通过一个HTTP请求删除同一个Bucket下的多个Object。
 *   - 支持一次请求内最多删除1000个Object。
 *   - 消息体（body）不超过2M。
 *   - 返回的消息体中只包含删除过程中出错的Object结果；如果所有Object都删除都成功的话，则没有消息体。
 *
 * 示例:
 * ```js
 * const response = await client.deleteMultipleObjects(
 *   "BucketName",
 *   [
 *     {"key": "my-object1"},
 *     {"key": "my-object2"}
 *   ]
 * );
 * ```
 *
 * 多版本示例:
 * ```js
 * const response = await client.deleteMultipleObjects(
 *   "BucketName",
 *   [
 *     {"key": "my-object1", versionId: "AISQpTmwRH1="},
 *     {"key": "my-object2", versionId: "AISQpTmwRHU="}
 *   ]
 * );
 * ```
 *
 * @param {string} bucketName 桶名称
 * @param {Array<{key: string; versionId?: string} | string>} objects 对象列表，最多1000个
 * @param {OptionsType=} options
 * @returns
 */
BosClient.prototype.deleteMultipleObjects = function (bucketName, objects, options) {
  options = options || {};

  const body = objects
    .map((file) => {
      if (typeof file === 'string') {
        return {key: file};
      } else if (typeof file === 'object') {
        const fileObject = {key: file.key};

        if (file.versionId && typeof file.versionId === 'string') {
          fileObject.versionId = file.versionId;
        }
        return fileObject;
      } else {
        return null;
      }
    })
    .filter((file) => file != null);

  return this.sendRequest('POST', {
    bucketName: bucketName,
    params: {delete: ''},
    body: JSON.stringify({
      objects: body
    }),
    config: options.config
  });
};

/**
 * 删除指定Bucket的一个Object，要求请求者对此Object有写权限。
 *
 * 示例:
 * ```js
 * const response = await client.deleteObject("Bucket", "ObjectName");
 * ```
 *
 * 多版本示例:
 * ```js
 * // 永久删除指定版本的Object
 * const response = await client.deleteObject("Bucket", "ObjectName", {versionId: 'AISQpTmwRHU='});
 *
 * // 临时删除当前版本的Object（不指定versionId），新增版本ID为"null"的Object
 * const response = await client.deleteObject("Bucket", "ObjectName");
 *
 * // 删除版本ID为"null"的Object
 * const response = await client.deleteObject("Bucket", "ObjectName", {versionId: 'null'});
 * ```
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/bkc5tsslq
 * @param {string} bucketName 桶名称
 * @param {string} key 对象名称（全路径）
 * @param {OptionsType=} options
 * @returns
 */
BosClient.prototype.deleteObject = function (bucketName, key, options) {
  options = options || {};

  const reqArgs = {
    bucketName: bucketName,
    key: key,
    config: options.config
  };

  if (options.versionId && typeof options.versionId === 'string') {
    reqArgs.params = {
      versionId: options.versionId
    };
  }

  return this.sendRequest('DELETE', reqArgs);
};

/**
 * @typedef {Object} PutObjectResponse
 * @property {Record<string, string>} http_headers 文件的http头部信息
 * @property {Record<string, never>} body 空对象
 */

BosClient.prototype.putObject = function (bucketName, key, data, options) {
  if (!key) {
    throw new TypeError('key should not be empty.');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    body: data,
    headers: options.headers,
    config: options.config
  });
};

/**
 * 以Blob对象形式上传，支持浏览器端调用
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} blob Blob对象
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 * @returns {PutObjectResponse}
 */
BosClient.prototype.putObjectFromBlob = function (bucketName, key, blob, options) {
  var headers = {};

  // https://developer.mozilla.org/en-US/docs/Web/API/Blob/size
  headers[H.CONTENT_LENGTH] = blob.size;
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // 而且根据 API 文档，这个字段不是必填的。
  options = u.extend(headers, options);

  return this.putObject(bucketName, key, blob, options);
};

/**
 * 以DataURL形式上传
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} data Base64编码的数据
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 * @returns {PutObjectResponse}
 */
BosClient.prototype.putObjectFromDataUrl = function (bucketName, key, data, options) {
  data = new Buffer(data, 'base64');

  var headers = {};
  headers[H.CONTENT_LENGTH] = data.length;
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // headers[H.CONTENT_MD5] = require('./crypto').md5sum(data);
  options = u.extend(headers, options);

  return this.putObject(bucketName, key, data, options);
};

/**
 * 以字符串形式上传
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} data  字符串数据
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 * @returns {PutObjectResponse}
 */
BosClient.prototype.putObjectFromString = function (bucketName, key, data, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_LENGTH] = Buffer.byteLength(data);
  headers[H.CONTENT_TYPE] = options[H.CONTENT_TYPE] || MimeType.guess(path.extname(key));
  headers[H.CONTENT_MD5] = crypto.md5sum(data);
  options = u.extend(headers, options);

  return this.putObject(bucketName, key, data, options);
};

/**
 * 以文件形式上传，支持Node.js环境调用
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} filename 文件路径
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 * @returns {PutObjectResponse}
 */
BosClient.prototype.putObjectFromFile = function (bucketName, key, filename, options) {
  options = options || {};

  var headers = {};

  // 如果没有显式的设置，就使用默认值
  var fileSize = fs.statSync(filename).size;
  var contentLength = u.has(options, H.CONTENT_LENGTH) ? options[H.CONTENT_LENGTH] : fileSize;
  if (contentLength > fileSize) {
    throw new Error("options['Content-Length'] should less than " + fileSize);
  }

  headers[H.CONTENT_LENGTH] = contentLength;

  // 因为Firefox会在发起请求的时候自动给 Content-Type 添加 charset 属性
  // 导致我们计算签名的时候使用的 Content-Type 值跟服务器收到的不一样，为了
  // 解决这个问题，我们需要显式的声明Charset
  headers[H.CONTENT_TYPE] = options[H.CONTENT_TYPE] || MimeType.guess(path.extname(filename));
  options = u.extend(headers, options);

  var streamOptions = {
    start: 0,
    end: Math.max(0, contentLength - 1)
  };

  var me = this;

  function putObjectWithRetry(lastRetryTimes) {
    return me.putObject(bucketName, key, fs.createReadStream(filename, streamOptions), options).catch(function (err) {
      var serverTimestamp = new Date(err[H.X_BCE_DATE]).getTime();

      BceBaseClient.prototype.timeOffset = serverTimestamp - Date.now();

      if (err[H.X_STATUS_CODE] === 400 && err[H.X_CODE] === 'Http400' && lastRetryTimes > 0) {
        return putObjectWithRetry(--lastRetryTimes);
      }

      return Q.reject(err);
    });
  }

  if (!u.has(options, H.CONTENT_MD5)) {
    var fp2 = fs.createReadStream(filename, streamOptions);
    return crypto.md5stream(fp2).then(function (md5sum) {
      options[H.CONTENT_MD5] = md5sum;
      return putObjectWithRetry(options.retryCount || MAX_RETRY_COUNT);
    });
  }

  return putObjectWithRetry(options.retryCount || MAX_RETRY_COUNT);
};

/**
 * 获取某个Object的Meta信息，但此时并不返回数据。
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {OptionsType=} options
 * @returns
 */
BosClient.prototype.getObjectMetadata = function (bucketName, key, options) {
  options = options || {};

  const reqArgs = {
    bucketName: bucketName,
    key: key,
    config: options.config
  };

  /** 多版本文件的版本ID */
  if (options.versionId && typeof options.versionId === 'string') {
    reqArgs.params = {
      versionId: options.versionId
    };
  }

  return this.sendRequest('HEAD', reqArgs);
};

/**
 * @typedef {Object} GetObjectResponse
 * @property {Record<string, string>} http_headers 文件的http头部信息
 * @property {Buffer} body 文件流
 */

/**
 * @typedef {Object} GetObjectOptions
 * @property {string} versionId 指定Object的versionId
 * @property {string=} x-bce-traffic-limit 单链接下载限速
 * @property {string} [key: string] 允许任意其他属性（符合 Record<string, any>）
 */

/**
 * 获取Object，将Object文件读取到一个Stream中
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/xkc5pcmcj
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string=} range 指定下载的文件范围，格式为"0-100"，单位为字节，默认不指定范围，
 * @param {OptionsType} options 额外的参数，包含Client配置信息，额外的请求头 (比如单链接下载限速：{'x-bce-traffic-limit': 819200})
 * @returns {GetObjectResponse}
 */
BosClient.prototype.getObject = function (bucketName, key, range, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!key) {
    throw new TypeError('key should not be empty.');
  }

  options = options || {};

  var headers = {};
  if (options[H.X_BCE_TRAFFIC_LIMIT]) {
    const limit = options[H.X_BCE_TRAFFIC_LIMIT];

    if (typeof limit !== 'number' || limit < 819200 || limit > 838860800) {
      throw new TypeError('x-bce-traffic-limit range should be 819200~838860800');
    }

    headers[H.X_BCE_TRAFFIC_LIMIT] = limit;
  }

  var outputStream = new WMStream();
  const reqArgs = {
    bucketName: bucketName,
    key: key,
    headers: u.extend(
      {
        Range: range ? util.format('bytes=%s', range) : ''
      },
      headers
    ),
    config: options.config,
    outputStream: outputStream
  };

  /** 多版本文件的版本ID */
  if (options.versionId && typeof options.versionId === 'string') {
    reqArgs.params = {
      versionId: options.versionId
    };
  }

  return this.sendRequest('GET', reqArgs).then(function (response) {
    response.body = Buffer.concat(outputStream.store);
    return response;
  });
};

/**
 * @typedef {Object} GetObjectFileResponse
 * @property {Record<string, string>} http_headers 文件的http头部信息
 * @property {Record<string, never>} body 空对象，因为文件已经写入本地文件
 */

/**
 * 获取Object，将Object写入本地文件中
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} filename 本地文件路径
 * @param {string=} range 需要下载的文件范围，单位为字节，默认不指定范围，格式为"0-100"
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头 (比如单链接下载限速：{'x-bce-traffic-limit': 819200})
 * @returns {GetObjectFileResponse}
 */
BosClient.prototype.getObjectToFile = function (bucketName, key, filename, range, options) {
  if (!key) {
    throw new TypeError('key should not be empty.');
  } else if (/\/\/+/.test(key)) {
    throw new TypeError('key should not contain consecutive forward slashes (/).');
  } else if (/^[/\\]/.test(key) || /[/\\]$/.test(key)) {
    throw new TypeError('key should not start or end with a forward slash (/) or a backslash (\\).');
  } else if (/\/\.\.\//.test(key)) {
    throw new TypeError('path in key should not contain consecutive periods (..).');
  }

  options = options || {};

  return this.sendRequest('GET', {
    bucketName: bucketName,
    key: key,
    headers: {
      Range: range ? util.format('bytes=%s', range) : ''
    },
    config: options.config,
    outputStream: fs.createWriteStream(filename)
  });
};

/**
 * 用于把一个已经存在的Object拷贝为另外一个Object，支持Object文件的长度范围是0Byte-5GB。该接口也可以用来实现Meta更新（使用replace模式且源和目标指向同一个文件）。此接口需要请求者在header中指定拷贝源。
 * CopyObject接口支持跨区域文件复制，即复制文件所在的源Bucket和目标Bucket可以不在同一region(目前只支持从其它Region向本Region复制数据)。当进行跨区域文件复制时，复制产生的流量会收取跨区域流量费。
 *
 * 示例:
 * ```js
 * const response = await client.copyObject(
 *   "SourceBucket",
 *   "SourceObject",
 *   "TargetBucket",
 *   "TargetObject",
 *   {
 *     "x-bce-copy-source": "/SourceBucket/SourceObject"
 *     "x-bce-copy-source-if-match": "3858f62230ac3c915f300c664312c11f"
 *     "x-bce-storage-class": "STANDARD_IA"
 *   }
 * );
 * ```
 *
 * 多版本请求示例:
 * ```js
 * const response = await client.copyObject(
 *   "SourceBucket",
 *   "SourceObject",
 *   "TargetBucket",
 *   "TargetObject",
 *   {
 *     "x-bce-copy-source": "/SourceBucket/SourceObject?versionId=AJyQ0XRhboY="
 *     "x-bce-copy-source-if-match": "3858f62230ac3c915f300c664312c11f"
 *     "x-bce-storage-class": "STANDARD_IA"
 *   }
 * );
 * ```
 *
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/Lkc5p9g3w
 * @param {string} sourceBucketName 源存储桶名称
 * @param {string} sourceKey 源对象名称（对象全路径）
 * @param {string} targetBucketName 目标存储桶名称
 * @param {string} targetKey 目标对象名称（对象全路径）
 * @param {OptionsType=} options
 * @returns
 */
BosClient.prototype.copyObject = function (sourceBucketName, sourceKey, targetBucketName, targetKey, options) {
  /* eslint-disable */
  if (!sourceBucketName) {
    throw new TypeError('sourceBucketName should not be empty');
  }
  if (!sourceKey) {
    throw new TypeError('sourceKey should not be empty');
  }
  if (!targetBucketName) {
    throw new TypeError('targetBucketName should not be empty');
  }
  if (!targetKey) {
    throw new TypeError('targetKey should not be empty');
  }
  /* eslint-enable */

  options = this._checkOptions(options || {});
  var hasUserMetadata = false;
  u.some(options.headers, function (value, key) {
    if (key.indexOf('x-bce-meta-') === 0) {
      hasUserMetadata = true;
      return true;
    }
  });

  /** 源Object地址 */
  options.headers['x-bce-copy-source'] = strings.normalize(util.format('/%s/%s', sourceBucketName, sourceKey), false);
  /** 如果指定了versionId参数，则将versionId拼接到copy-source参数中 */
  if (options.versionId) {
    options.headers['x-bce-copy-source'] += `?versionId=${options.versionId}`;
  }

  if (u.has(options.headers, 'ETag')) {
    options.headers['x-bce-copy-source-if-match'] = options.headers.ETag;
  }
  options.headers['x-bce-metadata-directive'] = hasUserMetadata ? 'replace' : 'copy';

  return this.sendRequest('PUT', {
    bucketName: targetBucketName,
    key: targetKey,
    headers: options.headers,
    config: options.config
  });
};

/**
 * 向BOS请求一个全局唯一的UploadId，用于表示此次MultipartUpload
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.initiateMultipartUpload = function (bucketName, key, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_TYPE] = MimeType.guess(path.extname(key));

  options = this._checkOptions(u.extend(headers, options));

  return this.sendRequest('POST', {
    bucketName: bucketName,
    key: key,
    params: {uploads: ''},
    headers: options.headers,
    config: options.config
  });
};

BosClient.prototype.abortMultipartUpload = function (bucketName, key, uploadId, options) {
  options = options || {};

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    key: key,
    params: {uploadId: uploadId},
    config: options.config
  });
};

/**
 * 当请求者用UploadPart将所有的Part都上传完成后，需要用此CompleteMultipartUpload命令完成整个MultipartUpload操作
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} uploadId 上传任务ID，由initiateMultipartUpload返回
 * @param {Array<{ETag: string, PartNumber: number}>} partList 已经上传的Part列表，按照PartNumber升序排列
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.completeMultipartUpload = function (bucketName, key, uploadId, partList, options) {
  var headers = {};
  headers[H.CONTENT_TYPE] = 'application/json; charset=UTF-8';
  options = this._checkOptions(u.extend(headers, options));

  return this.sendRequest('POST', {
    bucketName: bucketName,
    key: key,
    body: JSON.stringify({parts: partList}),
    headers: options.headers,
    params: {uploadId: uploadId},
    config: options.config
  });
};

/**
 * 分片上传Part，以文件形式上传，支持Node.js环境调用
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} uploadId 上传任务ID，由initiateMultipartUpload返回
 * @param {number} partNumber 文件分片编号，从1开始
 * @param {number} partSize 分片大小，单位为字节
 * @param {string} filename 文件路径
 * @param {number} offset 文件偏移量，单位为字节
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.uploadPartFromFile = function (
  bucketName,
  key,
  uploadId,
  partNumber,
  partSize,
  filename,
  offset,
  options
) {
  var start = offset;
  var end = offset + partSize - 1;
  var partFp = fs.createReadStream(filename, {
    start: start,
    end: end
  });
  return this.uploadPart(bucketName, key, uploadId, partNumber, partSize, partFp, options);
};

/**
 * 分片上传Part，以Blob对象形式上传，支持浏览器环境调用
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} uploadId 上传任务ID，由initiateMultipartUpload返回
 * @param {number} partNumber 文件分片编号，从1开始
 * @param {number} partSize 分片大小，单位为字节
 * @param {Blob} blob Blob对象
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.uploadPartFromBlob = function (bucketName, key, uploadId, partNumber, partSize, blob, options) {
  if (blob.size !== partSize) {
    throw new TypeError(util.format('Invalid partSize %d and data length %d', partSize, blob.size));
  }

  var headers = {};
  headers[H.CONTENT_LENGTH] = partSize;
  headers[H.CONTENT_TYPE] = 'application/octet-stream';
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // headers[H.CONTENT_MD5] = require('./crypto').md5sum(data);

  options = this._checkOptions(u.extend(headers, options));
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    body: blob,
    headers: options.headers,
    params: {
      partNumber: partNumber,
      uploadId: uploadId
    },
    config: options.config
  });
};

/**
 * 分片上传Part，以DataUrl的形式上传
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} uploadId 上传任务ID，由initiateMultipartUpload返回
 * @param {number} partNumber 文件分片编号，从1开始
 * @param {number} partSize 分片大小，单位为字节
 * @param {string} dataUrl DataUrl字符串
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.uploadPartFromDataUrl = function (
  bucketName,
  key,
  uploadId,
  partNumber,
  partSize,
  dataUrl,
  options
) {
  var data = new Buffer(dataUrl, 'base64');
  if (data.length !== partSize) {
    throw new TypeError(util.format('Invalid partSize %d and data length %d', partSize, data.length));
  }

  var headers = {};
  headers[H.CONTENT_LENGTH] = partSize;
  headers[H.CONTENT_TYPE] = 'application/octet-stream';
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // headers[H.CONTENT_MD5] = require('./crypto').md5sum(data);

  options = this._checkOptions(u.extend(headers, options));
  return this.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    body: data,
    headers: options.headers,
    params: {
      partNumber: partNumber,
      uploadId: uploadId
    },
    config: options.config
  });
};

/**
 * 分片上传Part, 以文件流形式上传
 *
 * @param {string} bucketName 存储桶名称
 * @param {string} key 对象名称（对象全路径）
 * @param {string} uploadId 上传任务ID，由initiateMultipartUpload返回
 * @param {number} partNumber 文件分片编号，从1开始
 * @param {number} partSize 分片大小，单位为字节
 * @param {stream.ReadStream} partFp 文件流
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.uploadPart = function (bucketName, key, uploadId, partNumber, partSize, partFp, options) {
  /* eslint-disable */
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty');
  }

  if (!key) {
    throw new TypeError('key should not be empty');
  }

  /* eslint-enable */
  if (partNumber < MIN_PART_NUMBER || partNumber > MAX_PART_NUMBER) {
    throw new TypeError(
      util.format(
        'Invalid partNumber %d. The valid range is from %d to %d.',
        partNumber,
        MIN_PART_NUMBER,
        MAX_PART_NUMBER
      )
    );
  }

  var client = this;

  // TODO(leeight) 计算md5的时候已经把 partFp 读完了，如果从头再来呢？
  var clonedPartFp = fs.createReadStream(partFp.path, {
    start: partFp.start,
    end: partFp.end
  });

  var headers = {};
  headers[H.CONTENT_LENGTH] = partSize;
  headers[H.CONTENT_TYPE] = 'application/octet-stream';
  // MD5在外部由调用方计算，这里不计算
  // headers[H.CONTENT_MD5] = partMd5;
  options = u.extend(headers, options);
  options = client._checkOptions(options);

  return client.sendRequest('PUT', {
    bucketName: bucketName,
    key: key,
    body: clonedPartFp,
    headers: options.headers,
    params: {
      partNumber: partNumber,
      uploadId: uploadId
    },
    config: options.config
  });
};

BosClient.prototype.uploadPartCopy = function (
  sourceBucket,
  sourceKey,
  targetBucket,
  targetKey,
  uploadId,
  partNumber,
  range,
  options
) {
  if (!sourceBucket) {
    throw new TypeError('sourceBucket should not be empty');
  }
  if (!sourceKey) {
    throw new TypeError('sourceKey should not be empty');
  }
  if (!targetBucket) {
    throw new TypeError('targetBucket should not be empty');
  }
  if (!targetKey) {
    throw new TypeError('targetKey should not be empty');
  }
  if (partNumber < MIN_PART_NUMBER || partNumber > MAX_PART_NUMBER) {
    throw new TypeError(
      util.format(
        'Invalid partNumber %d. The valid range is from %d to %d.',
        partNumber,
        MIN_PART_NUMBER,
        MAX_PART_NUMBER
      )
    );
  }

  options = this._checkOptions(options || {});
  options.headers['x-bce-copy-source'] = strings.normalize(util.format('/%s/%s', sourceBucket, sourceKey), false);
  options.headers['x-bce-copy-source-range'] = range ? util.format('bytes=%s', range) : '';

  return this.sendRequest('PUT', {
    bucketName: targetBucket,
    key: targetKey,
    headers: options.headers,
    config: options.config,
    params: {partNumber: partNumber, uploadId: uploadId}
  });
};

BosClient.prototype.listParts = function (bucketName, key, uploadId, options) {
  /* eslint-disable */
  if (!uploadId) {
    throw new TypeError('uploadId should not empty');
  }
  /* eslint-enable */

  var allowedParams = ['maxParts', 'partNumberMarker', 'uploadId'];
  options = this._checkOptions(options || {}, allowedParams);
  options.params.uploadId = uploadId;

  return this.sendRequest('GET', {
    bucketName: bucketName,
    key: key,
    params: options.params,
    config: options.config
  });
};

BosClient.prototype.listMultipartUploads = function (bucketName, options) {
  var allowedParams = ['delimiter', 'maxUploads', 'keyMarker', 'prefix', 'uploads'];

  options = this._checkOptions(options || {}, allowedParams);
  options.params.uploads = '';

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: options.params,
    config: options.config
  });
};

BosClient.prototype.appendObject = function (bucketName, key, data, offset, options) {
  if (!key) {
    throw new TypeError('key should not be empty.');
  }

  options = this._checkOptions(options || {});
  var params = {append: ''};
  if (u.isNumber(offset)) {
    params.offset = offset;
  }
  return this.sendRequest('POST', {
    bucketName: bucketName,
    key: key,
    body: data,
    headers: options.headers,
    params: params,
    config: options.config
  });
};

BosClient.prototype.appendObjectFromBlob = function (bucketName, key, blob, offset, options) {
  var headers = {};

  // https://developer.mozilla.org/en-US/docs/Web/API/Blob/size
  headers[H.CONTENT_LENGTH] = blob.size;
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // 而且根据 API 文档，这个字段不是必填的。
  options = u.extend(headers, options);

  return this.appendObject(bucketName, key, blob, offset, options);
};

BosClient.prototype.appendObjectFromDataUrl = function (bucketName, key, data, offset, options) {
  data = new Buffer(data, 'base64');

  var headers = {};
  headers[H.CONTENT_LENGTH] = data.length;
  // 对于浏览器调用API的时候，默认不添加 H.CONTENT_MD5 字段，因为计算起来比较慢
  // headers[H.CONTENT_MD5] = require('./crypto').md5sum(data);
  options = u.extend(headers, options);

  return this.appendObject(bucketName, key, data, offset, options);
};

BosClient.prototype.appendObjectFromString = function (bucketName, key, data, offset, options) {
  options = options || {};

  var headers = {};
  headers[H.CONTENT_LENGTH] = Buffer.byteLength(data);
  headers[H.CONTENT_TYPE] = options[H.CONTENT_TYPE] || MimeType.guess(path.extname(key));
  headers[H.CONTENT_MD5] = crypto.md5sum(data);
  options = u.extend(headers, options);

  return this.appendObject(bucketName, key, data, offset, options);
};

BosClient.prototype.appendObjectFromFile = function (bucketName, key, filename, offset, size, options) {
  options = options || {};
  if (size === 0) {
    return this.appendObjectFromString(bucketName, key, '', offset, options);
  }

  var headers = {};

  // append的起止位置应该在文件内
  var fileSize = fs.statSync(filename).size;
  if (size + offset > fileSize) {
    throw new Error("Can't read the content beyond the end of file.");
  }

  headers[H.CONTENT_LENGTH] = size;

  // 因为Firefox会在发起请求的时候自动给 Content-Type 添加 charset 属性
  // 导致我们计算签名的时候使用的 Content-Type 值跟服务器收到的不一样，为了
  // 解决这个问题，我们需要显式的声明Charset
  headers[H.CONTENT_TYPE] = options[H.CONTENT_TYPE] || MimeType.guess(path.extname(filename));
  options = u.extend(headers, options);

  var streamOptions = {
    start: offset || 0,
    end: (offset || 0) + size - 1
  };
  var fp = fs.createReadStream(filename, streamOptions);
  if (!u.has(options, H.CONTENT_MD5)) {
    var me = this;
    var fp2 = fs.createReadStream(filename, streamOptions);
    return crypto.md5stream(fp2).then(function (md5sum) {
      options[H.CONTENT_MD5] = md5sum;
      return me.appendObject(bucketName, key, fp, offset, options);
    });
  }

  return this.appendObject(bucketName, key, fp, offset, options);
};

/**
 * Generate PostObject policy signature.
 *
 * @param {Object} policy The policy object.
 * @return {string}
 */
BosClient.prototype.signPostObjectPolicy = function (policy) {
  var credentials = this.config.credentials;
  var auth = new Auth(credentials.ak, credentials.sk);

  policy = new Buffer(JSON.stringify(policy)).toString('base64');
  var signature = auth.hash(policy, credentials.sk);

  return {
    policy: policy,
    signature: signature
  };
};

/**
 * 使用HTML表单上传文件到指定bucket，用于实现通过浏览器上传文件到bucket。在PutObject操作中通过HTTP请求头传递参数，在PostObject操作中使用消息实体中的表单域传递参数，其中消息实体使用多重表单格式（multipart/form-data）编码
 *
 * @see http://wiki.baidu.com/pages/viewpage.action?pageId=161461681
 * @doc https://cloud.baidu.com/doc/BOS/s/akc5orrn5
 * @param {string} bucketName The bucket name.
 * @param {string} key The object name.
 * @param {string|Buffer} data The file raw data or file path.
 * @param {OptionsType} options The form fields.
 * @return {Promise}
 */
BosClient.prototype.postObject = function (bucketName, key, data, options) {
  var boundary = 'MM8964' + (Math.random() * Math.pow(2, 63)).toString(36);
  var contentType = 'multipart/form-data; boundary=' + boundary;

  if (u.isString(data)) {
    data = fs.readFileSync(data);
  } else if (!Buffer.isBuffer(data)) {
    throw new Error('Invalid data type.');
  }

  var credentials = this.config.credentials;
  var ak = credentials.ak;

  var blacklist = ['signature', 'accessKey', 'key', 'file'];
  options = u.omit(options || {}, blacklist);

  var multipart = new Multipart(boundary);
  for (var k in options) {
    if (options.hasOwnProperty(k)) {
      if (k !== 'policy') {
        multipart.addPart(k, options[k]);
      }
    }
  }

  if (options.policy) {
    var rv = this.signPostObjectPolicy(options.policy);
    multipart.addPart('policy', rv.policy);
    multipart.addPart('signature', rv.signature);
  }

  multipart.addPart('accessKey', ak);
  multipart.addPart('key', key);
  multipart.addPart('file', data);

  var body = multipart.encode();
  var headers = {};
  headers[H.CONTENT_TYPE] = contentType;

  if (options[H.X_BCE_TRAFFIC_LIMIT]) {
    const limit = options[H.X_BCE_TRAFFIC_LIMIT];

    if (typeof limit !== 'number' || limit < 819200 || limit > 838860800) {
      throw new TypeError('x-bce-traffic-limit range should be 819200~838860800');
    }

    headers[H.X_BCE_TRAFFIC_LIMIT] = limit;
  }

  return this.sendRequest('POST', {
    bucketName: bucketName,
    body: body,
    headers: headers
  });
};

/**
 * 取回归档存储文件，请求者必须有归档存储文件的读权限，并且归档存储文件处于冰冻状态
 * @doc https://cloud.baidu.com/doc/BOS/s/akc5t3f12
 * @param {string} bucketName 桶名称
 * @param {string} objectName 对象名称
 */
BosClient.prototype.restoreObject = function (bucketName, objectName, options) {
  if (!objectName) {
    throw new TypeError('objectName should not be empty.');
  }

  options = this._checkOptions(options || {});
  var headers = options.headers;

  if (headers.hasOwnProperty(H.X_BCE_RESTORE_DAYS)) {
    const restoreDays = headers[H.X_BCE_RESTORE_DAYS];

    if (!u.isNumber(restoreDays) || restoreDays < 0 || restoreDays > 30) {
      throw new TypeError('x-bce-restore-days should be an integer with range of 0 ~ 30');
    }
  }

  if (headers.hasOwnProperty(H.X_BCE_RESTORE_TIER)) {
    const restoreTier = headers[H.X_BCE_RESTORE_TIER];
    const restoreTierEnum = ['Expedited', 'Standard', 'LowCost'];

    if (!~restoreTierEnum.indexOf(restoreTier)) {
      throw new TypeError('x-bce-restore-tier should be ' + restoreTierEnum.join(', '));
    }
  }

  return this.sendRequest('POST', {
    bucketName,
    key: objectName,
    params: {restore: ''},
    headers: options.headers,
    config: options.config
  });
};

/**
 * 获取软连接，需要对软连接有读取权限，接口响应头的x-bce-symlink-target指向目标文件
 */
BosClient.prototype.getSymlink = function (bucketName, objectName, options) {
  options = options || {};

  return this.sendRequest('GET', {
    bucketName,
    key: objectName,
    params: {symlink: ''},
    config: options.config
  });
};

/**
 * 为BOS的相同bucket下已有的目的object创建软链接
 * @param {string} bucketName 桶名称
 * @param {string} objectName 软连接文件名称
 * @param {string} target 目标对象名称
 * @param {boolean} overwrite 是否覆盖同名Object，默认允许覆盖
 */
BosClient.prototype.putSymlink = function (bucketName, objectName, target, overwrite, options) {
  options = options || {};
  var headers = {};

  if (!target) {
    throw new TypeError('target object should not be empty.');
  }

  headers[H.X_BCE_SYMLINK_TARGET] = target;
  headers[H.X_BCE_FORBID_OVERWRITE] = overwrite === true;

  return this.sendRequest('PUT', {
    bucketName,
    key: objectName,
    params: {symlink: ''},
    headers: headers,
    config: options.config
  });
};

/**
 * 设置用户的Quota
 */
BosClient.prototype.putUserQuota = function (body, options) {
  options = options || {};
  body = u.pick(body || {}, ['maxBucketCount', 'maxCapacityMegaBytes']);

  if (body.maxBucketCount == null || body.maxCapacityMegaBytes == null) {
    throw new TypeError('maxBucketCount or maxCapacityMegaBytes should not be empty.');
  }

  if (typeof body.maxBucketCount !== 'number' || typeof body.maxCapacityMegaBytes !== 'number') {
    throw new TypeError('maxBucketCount or maxCapacityMegaBytes should not be number.');
  }

  return this.sendRequest('PUT', {
    params: {userQuota: ''},
    body: JSON.stringify(body),
    config: options.config
  });
};

/**
 * 获取用户的Quota
 */
BosClient.prototype.getUserQuota = function (options) {
  options = options || {};

  return this.sendRequest('GET', {
    params: {userQuota: ''},
    config: options.config
  });
};

/**
 * 删除额度设置
 */
BosClient.prototype.deleteUserQuota = function (options) {
  options = options || {};

  return this.sendRequest('DELETE', {
    params: {userQuota: ''},
    config: options.config
  });
};

/**
 * 此接口用于从指定URL抓取资源，并将资源存储到指定的Bucket中。此操作需要请求者对该Bucket有写权限，每次只能抓取一个Object，且用户可以自定义Object的名称。
 * FetchObject接口抓取资源的大小限制为0~10GB。其中`x-bce-fetch-source`为必填写参数，表示待抓取资源的源URL地址。
 *
 * 示例:
 * ```js
 * const response = await client.fetchObject(
 *   bucketName,
 *   objectName,
 *   {'x-bce-fetch-source': 'http://www.abc.com/img.jpg'}
 * );
 * ```
 *
 * @param {string} bucketName 桶名称
 * @param {string} objectName 文件名称
 * @param {Record<string, any>} options 额外的参数，包含Client配置信息，额外的请求头等
 */
BosClient.prototype.fetchObject = function (bucketName, objectName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!objectName) {
    throw new TypeError('objectName should not be empty.');
  }

  options = this._checkOptions(options || {}, [H.X_BCE_FETCH_SOURCE]);
  var headers = options.headers;

  if (!headers[H.X_BCE_FETCH_SOURCE]) {
    throw new TypeError('x-bce-fetch-source should not be empty, at least in query string or headers.');
  }

  return this.sendRequest('POST', {
    bucketName,
    key: objectName,
    params: u.extend({fetch: ''}, qs.encode(options.params)),
    headers: headers,
    config: options.config
  });
};

/**
 * 浏览器在发送跨域请求之前会发送一个preflight请求（OPTIONS）并带上特定的来源域, OPTIONS Object操作不需要进行鉴权。
 */
BosClient.prototype.optionsObject = function (bucketName, objectName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!objectName) {
    throw new TypeError('objectName should not be empty.');
  }

  options = this._checkOptions(options || {});
  var headers = options.headers;

  if (!headers.hasOwnProperty(H.ORIGIN)) {
    throw new TypeError('Origin should not be empty.');
  }

  if (!headers.hasOwnProperty(H.ACCESS_CONTROL_REQUEST_METHOD)) {
    throw new TypeError('Access-Control-Request-Method should not be empty.');
  }

  return this.sendRequest('OPTIONS', {
    bucketName,
    key: objectName,
    headers: headers,
    config: options.config
  });
};

/**
 * 向Bucket中指定object执行SQL语句，选取出指定内容返回
 * @doc https://cloud.baidu.com/doc/BOS/s/Xkc5t84nz
 */
BosClient.prototype.selectObject = function (bucketName, objectName, body, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!objectName) {
    throw new TypeError('objectName should not be empty.');
  }

  options = this._checkOptions(options || {});
  body = u.pick(body || {}, ['selectRequest', 'type']);

  if (!type || !~['json', 'csv'].indexOf(body.type)) {
    throw new TypeError('field "type" should be one of "json" and "csv".');
  }

  return this.sendRequest('POST', {
    bucketName,
    key: objectName,
    params: u.extend({select: '', type: body.type}),
    body: JSON.stringify({selectRequest: body.selectRequest}),
    headers: options.headers,
    config: options.config
  });
};

// --- E N D ---
BosClient.prototype.sendRequest = function (httpMethod, varArgs, requestUrl) {
  debug('<sendRequest> httpMethod = %j', httpMethod);
  debug('<sendRequest> varArgs = %j', varArgs);
  debug('<sendRequest> requestUrl = %j', requestUrl);

  var defaultArgs = {
    bucketName: null,
    key: null,
    body: null,
    headers: {},
    params: {},
    config: {},
    outputStream: null
  };

  var endpoint = this.config.endpoint;

  const bucketName = varArgs.bucketName;
  /**
   * 优先使用API级别传入的region配置，如果未设置，则使用全局endpoint继续处理
   */
  const region = varArgs.config ? varArgs.config.region : '';
  const localRemoveVersionPrefix = varArgs.config ? varArgs.config.removeVersionPrefix : false;
  const versionPrefix = localRemoveVersionPrefix || this.config.removeVersionPrefix ? '/' : '/v1';

  varArgs.bucketName = this.config.cname_enabled ? '' : bucketName;

  const customGenerateUrl =
    varArgs.config && varArgs.config.customGenerateUrl
      ? varArgs.config.customGenerateUrl
      : this.config.customGenerateUrl
      ? this.config.customGenerateUrl
      : undefined;

  var pathStyleEnable = !!domainUtils.isIpHost(endpoint) || this.config.pathStyleEnable;

  // provide the method for generating url
  if (typeof customGenerateUrl === 'function') {
    endpoint = customGenerateUrl(bucketName, region);
    var resource =
      requestUrl ||
      path.normalize(path.join(versionPrefix, strings.normalize(varArgs.key || '', false))).replace(/\\/g, '/');
  } else {
    endpoint = domainUtils.handleEndpoint({
      bucketName,
      endpoint,
      region,
      protocol: this.config.protocol,
      cname_enabled: this.config.cname_enabled,
      pathStyleEnable
    });

    var resource =
      requestUrl ||
      path
        .normalize(
          path.join(
            versionPrefix ? '/' : '/v1',
            // if pathStyleEnable is true
            !pathStyleEnable ? '' : strings.normalize(varArgs.bucketName || ''),
            strings.normalize(varArgs.key || '', false)
          )
        )
        .replace(/\\/g, '/');
  }

  var args = u.extend(defaultArgs, varArgs);
  var config = u.extend({}, this.config, args.config, {endpoint});

  debug('<sendRequest> args = %j', args);
  debug('<sendRequest> config = %j', config);

  if (config.sessionToken) {
    args.headers[H.SESSION_TOKEN] = config.sessionToken;
  }
  return this.sendHTTPRequest(httpMethod, resource, args, config);
};

// BosClient.prototype.createSignature = function (credentials, httpMethod, path, params, headers) {
//     var revisionTimestamp = Date.now() + (this.timeOffset || 0);

//     headers[H.X_BCE_DATE] = new Date(revisionTimestamp).toISOString().replace(/\.\d+Z$/, 'Z');

//     var auth = new Auth(credentials.ak, credentials.sk);
//     return auth.generateAuthorization(httpMethod, path, params, headers, revisionTimestamp / 1000);
// };

/**
 *
 * @param {string} httpMethod GET,POST,PUT,DELETE,HEAD
 * @param {string} resource The http request path.
 * @param {Object} args The request info.
 * @param {Object} config The http client configuration
 */
BosClient.prototype.sendHTTPRequest = function (httpMethod, resource, args, config) {
  var client = this;

  function doRequest() {
    var agent = (this._httpAgent = new HttpClient(config));
    var httpContext = {
      httpMethod: httpMethod,
      resource: resource,
      args: args,
      config: config
    };
    u.each(['progress', 'error', 'abort', 'timeout'], function (eventName) {
      agent.on(eventName, function (evt) {
        client.emit(eventName, evt, httpContext);
      });
    });

    var promise = this._httpAgent.sendRequest(
      httpMethod,
      resource,
      args.body,
      args.headers,
      args.params,
      // 支持自定义签名函数
      u.isFunction(config.createSignature) ? u.bind(config.createSignature, this) : u.bind(this.createSignature, this),
      args.outputStream
    );

    promise.abort = function () {
      if (agent._req) {
        // 浏览器请求
        if (agent._req.xhr) {
          var xhr = agent._req.xhr;
          xhr.abort();
        }
        // node环境下可能拿不到xhr实例，直接调用_req的abort方法
        else if (config.requestInstance) {
          agent._req.abort();
        }
      }
    };

    return promise;
  }

  const instance = doRequest.call(client);
  const result = instance.catch(function (err) {
    var serverTimestamp = new Date(err[H.X_BCE_DATE]).getTime();

    BceBaseClient.prototype.timeOffset = serverTimestamp - Date.now();

    if (err[H.X_STATUS_CODE] === 403 && err[H.X_CODE] === 'RequestTimeTooSkewed') {
      return doRequest.call(client);
    }

    return Q.reject(err);
  });

  if (config.requestInstance) {
    return [result, instance];
  }
  return result;
};

BosClient.prototype._checkOptions = function (options, allowedParams) {
  var rv = {};

  rv.config = options.config || {};
  rv.headers = this._prepareObjectHeaders(options);
  rv.params = u.pick(options, allowedParams || []);

  if (options.versionId && typeof options.versionId === 'string') {
    rv.versionId = options.versionId;
  }

  /** 如果使用callback参数格式传入，将参数处理为字符串格式 */
  if (!u.has(options, H.X_BCE_PROCESS) && u.has(options, 'callback')) {
    const callbackParams = u.extend(
      {
        /** urls, 缩写为u */
        u: Base64.urlEncode(options.callback.urls),
        /** mode, 缩写为u */
        m: 'sync',
        v: Base64.urlEncode(options.callback.vars)
      },
      /** encrypt, 缩写为e */
      options.callback.encrypt && options.callback.encrypt === 'config' ? {e: 'config'} : {},
      /** key, 缩写为k */
      options.callback.key ? {k: options.callback.key} : {}
    );
    let callbackStr = '';
    const callbackKeys = Object.keys(callbackParams);

    callbackKeys.forEach((key, index) => {
      callbackStr += key + '_' + callbackParams[key] + (index === callbackKeys.length - 1 ? '' : ',');
    });

    if (callbackStr) {
      rv.headers[H.X_BCE_PROCESS] = 'callback/callback,' + callbackStr;
    }
  }

  return rv;
};

BosClient.prototype._prepareObjectHeaders = function (options) {
  var allowedHeaders = [
    H.ORIGIN,
    H.ACCESS_CONTROL_REQUEST_METHOD,
    H.ACCESS_CONTROL_REQUEST_HEADERS,
    H.CONTENT_LENGTH,
    H.CONTENT_ENCODING,
    H.CONTENT_MD5,
    H.X_BCE_CONTENT_SHA256,
    H.CONTENT_TYPE,
    H.CONTENT_DISPOSITION,
    H.ETAG,
    H.SESSION_TOKEN,
    H.CACHE_CONTROL,
    H.EXPIRES,
    H.X_BCE_ACL,
    H.X_BCE_GRANT_READ,
    H.X_BCE_GRANT_FULL_CONTROL,
    H.X_BCE_OBJECT_ACL,
    H.X_BCE_OBJECT_GRANT_READ,
    H.X_BCE_STORAGE_CLASS,
    H.X_BCE_SERVER_SIDE_ENCRYPTION,
    H.X_BCE_RESTORE_DAYS,
    H.X_BCE_RESTORE_TIER,
    H.X_BCE_SYMLINK_TARGET,
    H.X_BCE_FORBID_OVERWRITE,
    H.X_BCE_TRAFFIC_LIMIT,
    H.X_BCE_FETCH_SOURCE,
    H.X_BCE_FETCH_MODE,
    H.X_BCE_CALLBACK_ADDRESS,
    H.X_BCE_FETCH_REFERER,
    H.X_BCE_FETCH_USER_AGENT,
    H.X_BCE_PROCESS,
    H.X_BCE_SOURCE,
    H.X_BCE_TAGGING
  ];
  var metaSize = 0;
  var headers = u.pick(options, function (value, key) {
    if (allowedHeaders.indexOf(key) !== -1) {
      return true;
    } else if (/^x\-bce\-meta\-/.test(key)) {
      metaSize += Buffer.byteLength(key) + Buffer.byteLength('' + value);
      return true;
    }
  });

  if (metaSize > MAX_USER_METADATA_SIZE) {
    throw new TypeError('Metadata size should not be greater than ' + MAX_USER_METADATA_SIZE + '.');
  }

  if (u.has(headers, H.CONTENT_LENGTH)) {
    var contentLength = headers[H.CONTENT_LENGTH];
    if (contentLength < 0) {
      throw new TypeError('content_length should not be negative.');
    } else if (contentLength > MAX_PUT_OBJECT_LENGTH) {
      // 5G
      throw new TypeError(
        'Object length should be less than ' + MAX_PUT_OBJECT_LENGTH + '. Use multi-part upload instead.'
      );
    }
  }

  if (u.has(headers, 'ETag')) {
    var etag = headers.ETag;
    if (!/^"/.test(etag)) {
      headers.ETag = util.format('"%s"', etag);
    }
  }

  if (!u.has(headers, H.CONTENT_TYPE)) {
    headers[H.CONTENT_TYPE] = 'application/octet-stream';
  }

  if (u.has(headers, H.X_BCE_STORAGE_CLASS)) {
    const storageClass = headers[H.X_BCE_STORAGE_CLASS];
    const STORAGE_CLASS = [
      /** 标准存储类型 */
      'STANDARD',
      /** 低频存储 */
      'STANDARD_IA',
      /** 归档存储 */
      'ARCHIVE',
      /** 冷存储 */
      'COLD',
      /** 标准存储-多AZ */
      'MAZ_STANDARD',
      /** 低频存储-多AZ */
      'MAZ_STANDARD_IA'
    ];

    if (!STORAGE_CLASS.includes(storageClass)) {
      headers[H.X_BCE_STORAGE_CLASS] = STORAGE_CLASS[0];
    }
  }

  return headers;
};

/**
 *
 * @param {{prefix:string,bucket:string,shareCode:string,durationSeconds:number}} body
 * @returns
 */
BosClient.prototype.createFolderShareUrl = function (body, config) {
  const endpoint = this.config.endpoint.replace(/^https?\:\/\//, '');
  return this.sendRequest(
    'POST',
    {
      body: JSON.stringify(u.extend({endpoint: endpoint}, body)),
      config: u.extend({protocol: 'https'}, config),
      params: {action: 'urlGet'}
    },
    'https://bos-share.baidubce.com/'
  );
};

/**
 * 进度回调函数
 *
 * @callback progressCallback
 * @param {Object} options 回调参数
 * @param {string} options.speed 当前上传速度
 * @param {string} options.progress 当前上传进度
 * @param {string} options.percent 当前上传进度-百分比
 * @param {number} options.uploadedBytes 已上传字节数
 * @param {number} options.totalBytes 文件总字节数
 */

/**
 * 进度回调函数
 *
 * @callback stateChangeCallback
 * @param {string} state 状态
 * @param {string} options.message 回调数据
 * @param {Object} options.data 回调数据
 */

/**
 * 自适应分片上传文件
 *
 * @param {Object} params 参数
 * @param {string} params.bucketName 存储桶名称
 * @param {string} params.objectName 上传后对象名称
 * @param {string|Buffer|Blob} params.data 上传数据, 类型为string时表示文件路径
 * @param {number} [params.chunkSize=5*1024**2] 默认分片大小, 单位为bytes
 * @param {number} [params.partConcurrency=5] 分片并发数
 * @param {string} [params.StorageClass=STANDARD] 存储类型
 * @param {string=} params.ContentLength 文件大小
 * @param {string=} params.ContentType MimeType
 * @param {string=} params.createTime 任务创建时间
 * @param {string=} params.uploadId 上传ID, 如果存在则表示任务已经初始化
 * @param {progressCallback=} params.onProgress 上传进度回调函数
 * @param {stateChangeCallback=} param.onStateChange 状态变化回调函数
 */
BosClient.prototype.putSuperObject = function (params) {
  params = params || {};
  const {objectName, data} = params;
  /** 上传文件的最大体积, 单位为bytes */
  const MAX_UPLOAD_FILE_SIZE = 48.8 * 1024 ** 4;
  // 上传后文件媒体类型
  const ContentType = params.ContentType || MimeType.guess(path.extname(objectName));
  // 文件大小, 单位bytes
  let ContentLength = params.ContentLength;
  // 数据类型: File, Buffer, Stream, Blob
  let dataType = '';

  if (typeof data === 'string') {
    ContentLength = fs.lstatSync(data).size;
    dataType = 'File';
  } else if (Buffer.isBuffer(data)) {
    ContentLength = data.length;
    dataType = 'Buffer';
  } else if (typeof stream === 'function' && data instanceof stream.Readable) {
    dataType = 'Stream';
  } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
    ContentLength = data.size;
    dataType = 'Blob';
  }

  if (!dataType) {
    throw new Error(`Unsupported data type: ${dataType}`);
  }

  if (ContentLength > MAX_UPLOAD_FILE_SIZE) {
    throw new Error('File size should be less or equal than 48.8TB.');
  }

  if (dataType === 'Stream') {
    throw new Error('file type is Stream, please use `putObject` API.');
  }

  const self = this;
  const instance = new SuperUpload(self, u.extend(params, {ContentLength, ContentType, dataType}));

  return instance;
};

/**
 * 创建bucket的合规保留策略，此时策略状态变成IN_PROGRESS状态
 * @doc https://cloud.baidu.com/doc/BOS/s/Xkc4jkho7
 */
BosClient.prototype.initBucketObjectLock = function (bucketName, body, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});
  body = u.pick(body || {}, ['retentionDays']);

  if (!body.retentionDays) {
    throw new TypeError('retentionDays should not be empty.');
  }

  return this.sendRequest('POST', {
    bucketName: bucketName,
    params: {objectlock: ''},
    body: JSON.stringify(body),
    config: options.config,
    headers: options.headers
  });
};

/**
 * 获取bucket的合规保留策略配置信息
 * @doc https://cloud.baidu.com/doc/BOS/s/bkc4lq5mq
 */
BosClient.prototype.getBucketObjectLock = function (bucketName, options) {
  options = options || {};

  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {objectlock: ''},
    config: options.config,
    headers: options.headers
  });
};

/**
 * 删除bucket设置的合规保留策略
 * @doc https://cloud.baidu.com/doc/BOS/s/rkc4lrfw8
 */
BosClient.prototype.deleteBucketObjectLock = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('DELETE', {
    bucketName: bucketName,
    params: {objectlock: ''},
    config: options.config,
    headers: options.headers
  });
};

/**
 * 延长bucket的合规保留策略保护周期
 * @doc https://cloud.baidu.com/doc/BOS/s/okc4ltaed
 */
BosClient.prototype.extendBucketObjectLock = function (bucketName, body, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});
  body = u.pick(body || {}, ['extendRetentionDays']);

  if (!body.extendRetentionDays) {
    throw new TypeError('extendRetentionDays should not be empty.');
  }

  return this.sendRequest('POST', {
    bucketName: bucketName,
    params: {extendobjectlock: ''},
    body: JSON.stringify(body),
    config: options.config,
    headers: options.headers
  });
};

/**
 * 立即锁定bucket合规保留策略，变成LOCKED锁定状态，当合规保留策略处于LOCKED锁定时，任何人不可删除该策略，除非删除该Bucket。
 * @doc https://cloud.baidu.com/doc/BOS/s/xkc4lsd70
 */
BosClient.prototype.completeBucketObjectLock = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('POST', {
    bucketName: bucketName,
    params: {completeobjectlock: ''},
    config: options.config,
    headers: options.headers
  });
};

/**
 * 获取Bucket的version状态。
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/zlxucuoxg
 * @param {string} bucketName Bucket Name
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.getBucketVersioning = function (bucketName, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('GET', {
    bucketName: bucketName,
    params: {versioning: ''},
    config: options.config,
    headers: options.headers
  });
};

/**
 * 设置指定存储空间（Bucket）的版本控制状态。
 *
 * @doc https://cloud.baidu.com/doc/BOS/s/flxucacoe
 *
 * @param {string} bucketName Bucket Name
 * @param {string} status 存储桶的多版本状态：开启（'enabled'）、暂停（ 'suspended'）或未开启（'notEnabled'）
 * @param {OptionsType=} options 额外的参数，包含Client配置信息，额外的请求头
 */
BosClient.prototype.putBucketVersioning = function (bucketName, status, options) {
  if (!bucketName) {
    throw new TypeError('bucketName should not be empty.');
  }

  if (!status) {
    throw new TypeError('status should not be empty.');
  }

  if (!['enabled', 'notEnabled', 'suspended'].includes(status)) {
    throw new TypeError('status should be one of "enabled", "notEnabled", "suspended"');
  }

  options = this._checkOptions(options || {});

  return this.sendRequest('PUT', {
    bucketName: bucketName,
    params: {versioning: ''},
    body: JSON.stringify({status: status}),
    config: options.config,
    headers: options.headers
  });
};

module.exports = BosClient;
