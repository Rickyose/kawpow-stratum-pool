var events = require('events');
var crypto = require('crypto');
var SHA3 = require('sha3');
var async = require('async');
var http = require('http');
var hasher_kawpow = require('hasher-kawpow');
var bignum = require('bignum');
var BigInt = require('big-integer');

var util = require('./util.js');
var daemon = require('./daemon.js');
var blockTemplate = require('./blockTemplate.js');

// Unique extranonce per subscriber
var ExtraNonceCounter = function () {
  this.next = function () {
  return(crypto.randomBytes(3).toString('hex'));
  };
};

//Unique job per new block template
var JobCounter = function () {
  var counter = 0x0000cccc;

  this.next = function () {
  counter++;
  if (counter % 0xffffffffff === 0) counter = 1;
  return this.cur();
  };

  this.cur = function () {
  var counter_buf = new Buffer(32);
  counter_buf.writeUIntBE('000000000000000000000000', 0, 24);
  counter_buf.writeUIntBE(counter, 24, 8);
  return counter_buf.toString('hex');
  };
};
function isHexString(s) {
  var check = String(s).toLowerCase();
  if(check.length % 2) {
    return false;
  }
  for (i = 0; i < check.length; i=i+2) {
  var c = check[i] + check[i+1];
  if (!isHex(c))
    return false;
  }
  return true;
}
function isHex(c) {
  var a = parseInt(c,16);
  var b = a.toString(16).toLowerCase();
  if(b.length % 2) { b = '0' + b; }
  if (b !== c) { return false; }
  return true;
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {

  var emitLog = function (text) { _this.emit('log', 'debug', text); };
  var emitWarningLog = function (text) { _this.emit('log', 'warning', text); };
  var emitErrorLog = function (text) { _this.emit('log', 'error', text); };
  var emitSpecialLog = function (text) { _this.emit('log', 'special', text); };

  //private members
  var _this = this;
  var jobCounter = new JobCounter();

  function SetupJobDaemonInterface(finishedCallback) {

    if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
      emitErrorLog('No daemons have been configured - pool cannot start');
      return;
    }

    _this.daemon = new daemon.interface(options.daemons, function (severity, message) {
      _this.emit('log', severity, message);
    });

    _this.daemon.once('online', function () {
      // console.log("The util daemon is alive.");
      finishedCallback();
    }).on('connectionFailed', function (error) {
      emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));
    }).on('error', function (message) {
      emitErrorLog(message);
    });
    _this.daemon.init();
  }

  SetupJobDaemonInterface(function () {});

  var shareMultiplier = algos[options.coin.algorithm].multiplier;

  //public members

  this.extraNonceCounter = new ExtraNonceCounter();

  this.currentJob;
  this.validJobs = {};

  var hashDigest = algos[options.coin.algorithm].hash(options.coin);

  var coinbaseHasher = (function () {
    switch (options.coin.algorithm) {
      default:
        return util.sha256d;
    }
  })();


  var blockHasher = (function () {
    switch (options.coin.algorithm) {
      case 'sha1':
        return function (d) {
          return util.reverseBuffer(util.sha256d(d));
        };
      default:
        return function (d) {
          return util.reverseBuffer(util.sha256(d));
        };
    }
  })();

  this.updateCurrentJob = function (rpcData) {
    var tmpBlockTemplate = new blockTemplate(
      jobCounter.next(),
      rpcData,
      options.coin.reward,
      options.recipients,
      options.address
    );

    _this.currentJob = tmpBlockTemplate;
    _this.emit('updatedBlock', tmpBlockTemplate, true);
    _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

  };

  //returns true if processed a new block
  this.processTemplate = function (rpcData) {

    /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
     block height is greater than the one we have */
    var isNewBlock = typeof(_this.currentJob) === 'undefined';
    if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
      isNewBlock = true;
      //If new block is outdated/out-of-sync than return
      if (rpcData.height < _this.currentJob.rpcData.height) return false;
    }

    if (!isNewBlock) return false;


    var tmpBlockTemplate = new blockTemplate(
      jobCounter.next(),
      rpcData,
      options.coin.reward,
      options.recipients,
      options.address
    );

    this.currentJob = tmpBlockTemplate;

    this.validJobs = {};
    _this.emit('newBlock', tmpBlockTemplate);

    this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    return true;

  };

  this.processShare = function (miner_given_jobId, previousDifficulty, difficulty, miner_given_nonce, ipAddress, port, workerName, miner_given_header, miner_given_mixhash, extraNonce1, solo) {

    var submitTime = Date.now() / 1000 | 0;

    var shareError = function (error) {
      _this.emit('share', {
          job: miner_given_jobId,
          ip: ipAddress,
          worker: workerName,
          difficulty: difficulty,
          error: error[1]
      });
      return { error: error, result: null };
    };

    var job = this.validJobs[miner_given_jobId];

    if (typeof job === 'undefined' || job.jobId != miner_given_jobId)
      return shareError([20, 'job not found']);

    //calculate our own header hash, do not trust miner-given value
    var headerBuffer = job.serializeHeader(); // 140 bytes, doesn't contain nonce or mixhash/solution
    var header_hash_buffer = util.reverseBuffer(util.sha256d(headerBuffer))
    var header_hash = header_hash_buffer.toString('hex');

    if (job.curTime < (submitTime - 600))
      return shareError([20, 'job is too old']);

    if (!isHexString(miner_given_header))
      return shareError([20, 'invalid header hash, must be hex']);
        
    if (header_hash != miner_given_header)
      return shareError([20, 'invalid header hash']);
    
    if (!isHexString(miner_given_nonce))
      return shareError([20, 'invalid nonce, must be hex']);
    
    if (!isHexString(miner_given_mixhash))
      return shareError([20, 'invalid mixhash, must be hex']);
    
    if (miner_given_nonce.length !== 16)
      return shareError([20, 'incorrect size of nonce, must be 8 bytes']);
    
    if (miner_given_mixhash.length !== 64)
      return shareError([20, 'incorrect size of mixhash, must be 32 bytes']);

    if (miner_given_nonce.indexOf(extraNonce1.substring(0,4)) !== 0)
      return shareError([24, 'nonce out of worker range']);

    if (!job.registerSubmit(header_hash.toLowerCase(), miner_given_nonce.toLowerCase()))
      return shareError([22, 'duplicate share']);

    var powLimit = algos.kawpow.diff; // TODO: Get algos object from argument
    var adjPow = powLimit / difficulty;
    if ((64 - adjPow.toString(16).length) === 0) {
        var zeroPad = '';
    }
    else {
        var zeroPad = '0';
        zeroPad = zeroPad.repeat((64 - (adjPow.toString(16).length)));
    }
    var target_share_hex = (zeroPad + adjPow.toString(16)).substr(0,64);
    
    var blockHashInvalid;
    var blockHash;
    var blockHex;

    var isValid = hasher_kawpow.verify(header_hash, miner_given_mixhash, miner_given_nonce, job.rpcData.height, target_share_hex, job.target_hex).split(" ");

    is_share = isValid[1]
    is_block = isValid[2]
    blockHashDigest = isValid[3]
    if (is_share === "false") {
        if (is_block === "false") {
            return shareError([20, 'kawpow validation failed']);
        }
    }

    // At this point, either share or block is true (or both)

    if (is_block === "true") {
        // Good block.
        blockHex = job.serializeBlock(new Buffer(header_hash, 'hex'), new Buffer(miner_given_nonce, 'hex'), new Buffer(miner_given_mixhash, 'hex')).toString('hex');
        blockHash = blockHashDigest;
    }
    var blockDiffAdjusted = job.difficulty * shareMultiplier
    var shareDiffFixed = undefined;

    if (blockHash !== undefined) {
        var headerBigNum = bignum.fromBuffer(blockHash, {endian: 'little', size: 32});
        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        shareDiffFixed = shareDiff.toFixed(8);
    }
    _this.emit('share', {
            job: miner_given_jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.coinbasevalue,
            difficulty: difficulty,
            shareDiff: shareDiffFixed,
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid,
            solo:solo
          }, blockHex);

    return {result: true, error: null, blockHash: blockHash};
  }
}
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
