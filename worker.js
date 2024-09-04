// for debug
const forceDownload = false;

/* global importScripts, zip */
/*
*/

//importScripts('./lib/zip.js');
//importScripts('./lib/ArrayBufferReader.js');
//importScripts('./lib/deflate.js');
//importScripts('./lib/inflate.js');



//var ZIP_URL = './big3.tar.gz';
//var ZIP_URL = './ct_report.tar.gz';
//var ZIP_URL = 'https://circleci-mim-results.s3.eu-central-1.amazonaws.com/PR/4367/236734/elasticsearch_and_cassandra_mnesia.27.0.1-amd64/big.tar.gz';
var ZIP_URL = 'http://localhost:8000/big3.tar.gz';

const ZIP_PREFIX = 'https://circleci-mim-results.s3.eu-central-1.amazonaws.com/';


const swListener = new BroadcastChannel('swListener');
swListener.postMessage("Importing scripts");

//importScripts('./lib/web-streams-polyfill.min.js');
//importScripts('./lib/zip-no-worker.min.js');
//importScripts('./lib/zip-full.min.js');

const SCOPE = "https://arcusfelis.github.io/html-zip-reader";

importScripts(SCOPE + '/lib/tar-web.js');
importScripts(SCOPE + '/lib/readable-web-to-node-stream.js');
importScripts(SCOPE + '/lib/blob-stream.js');

//zip.configure({useWebWorkers: false, useCompressionStream: true});
swListener.postMessage("Scripts imported");

/*
let call = 0;
BlobStream.prototype._write_orig = BlobStream.prototype._write;
BlobStream.prototype._write = function(chunk, encoding, callback) {
//if (!call)
    console.log("chunk1 " + chunk.length);
  call++;
  return this._write_orig(chunk, encoding, callback);
}
*/

function mergeArrays(myArrays) {
if (myArrays.length == 0) return "";
if (myArrays.length == 1) return myArrays[0];

// Get the total length of all arrays.
let length = 0;
myArrays.forEach(item => {
  length += item.length;
});

// Create a new array with total length and merge all source arrays.
let mergedArray = new Uint8Array(length);
let offset = 0;
myArrays.forEach(item => {
  mergedArray.set(item, offset);
  offset += item.length;
});
return mergedArray;
}

// During installation, extend the event to recover the package
// for this recipe and install into an offline cache.
self.oninstall = function(event) {
  console.log("worker.path=" + self.location.href);
  const skip = self.skipWaiting.bind(self);
  caches.keys().then(function(names) {
      const promises = [];
      for (let name of names)
          promises.push(caches.delete(name));
      Promise.all([]).then(() => skip());
  });
//event.waitUntil(self.clients.claim());
};

// dirname("http://localhost:8000/worker.js") => "http://localhost:8000/"
function dirname(path) {
  return path.substring(0, path.lastIndexOf("/")+1);
}

async function downloadZip(dir, cache, tarPath) {
  const startTime = performance.now();
  swListener.postMessage("Downloading zip");
//  const response = await fetch(ZIP_URL);

  const response = await fetch(ZIP_PREFIX + tarPath);
  const body = await response.body;
  swListener.postMessage("Downloaded zip");
  const ds = new DecompressionStream("gzip");
  const decompressedStream = body.pipeThrough(ds);
  
  const [decompressedStream1, decompressedStream2] = decompressedStream.tee();

  const fetchTarPromise = fetchTar(decompressedStream1)
  const chunksReadyPromise = fetchStream(decompressedStream2, dir, cache);

  const files = await fetchTarPromise;
  const {parts, putPromises} = await chunksReadyPromise;
  await Promise.all(putPromises);
  console.log("Parts " + parts.length);

  const endTime = performance.now();
  swListener.postMessage("Parsed TAR " + (endTime - startTime) + " milliseconds");
  return {files, parts};
}

async function downloadIfNotCached(cacheName, dir, tarPath) {
  const filesUrl = dir + "/files.json";
  const cache = await openCache(cacheName);
  let filesReq = await cache.match(filesUrl);
  if (forceDownload || !filesReq) {
    const zip = await downloadZip(dir, cache, tarPath);
    // Put parts also in the same request, so 1 request instead of two needed
    zip.files.parts = zip.parts;
    await cache.put(filesUrl, new Response(JSON.stringify(zip.files)));
    filesReq = await cache.match(filesUrl);
  }
  if (!filesReq) {
    console.log("Failed to find files list for " + cacheName);
    return;
  }
  const files = await filesReq.json();
  console.log("Got a list of files");
  console.dir(files);
  return {files, cache};
}

function fetchTar(decompressedStream1) {
  return new Promise(function(fulfill, reject) {
        const extract = tar.extract();
        const files = {};
        let entriesCount = 0;
        extract.on('entry', function (header, stream, next) {
          entriesCount++;
          if (header.type == "directory") {
            next();
            stream.resume();
            return;
          }
          files[prepareFileName(header.name)] = {offset: extract._offset, size: header.size};
          next(); // ready for next entry
          stream.resume(); // just auto drain the stream
        });
        extract.on('finish', function () {
          // all entries read
          console.log("all entries read " + entriesCount);
          fulfill(files);
        });
        const nodeStream = new ReadableWebToNodeStream(decompressedStream1);
        nodeStream.pipe(extract);
   });
}

// Remove prefix from name
// filename looks like ./all_runs.html
function prepareFileName(str) {
  const prefix = "./";
  if (str.startsWith(prefix)) {
    return str.slice(prefix.length);
  }
  return str;
}


function fetchStream(stream, dir, cache) {
  return new Promise(function(fulfill, reject) {
    return fetchStream2(stream, fulfill, dir, cache);
  });
}

function fetchStream2(stream, fulfill, dir, cache) {
  const reader = stream.getReader();
  let bytesReceived = 0;
  let absOffset = 0;
  let partOffset = 0;

  const PART_SIZE = 1000000;
  let PART_NUM = 0;
  let chunks = [];
  const parts = [];

  const putPromises = [];

  // read() returns a promise that resolves
  // when a value has been received
  reader.read().then(function processChunk({ done, value }) {
    // Result objects contain two properties:
    // done  - true if the stream has already given you all its data.
    // value - some data. Always undefined when done is true.

//  console.log("get chunk " + value.length);

    if (value) {
      chunks.push(value);
      // value for fetch streams is a Uint8Array
      bytesReceived += value.length;
      absOffset += value.length;
    }

    if (((bytesReceived > PART_SIZE) || done) && bytesReceived) {
      // split logic
      console.log("Part received partSize=" + bytesReceived + " partOffset=" + partOffset);
      parts.push({size: bytesReceived, offset: partOffset});

      const putPromise = cache.put(dir + "/part" + (parts.length - 1), new Response(mergeArrays(chunks)));
      putPromises.push(putPromise);
      
      chunks = [];
      bytesReceived = 0;
      partOffset = absOffset;
    }

    if (done) {
      console.log("Stream complete");
      fulfill({parts, putPromises});
      return;
    }

    // Read some more, and call this function again
    return reader.read().then(processChunk);
  });
}

// Control the clients as soon as possible.
self.onactivate = function(event) {
  event.waitUntil(self.clients.claim());
};

function removePrefix(str, prefix) {
  if (str.startsWith(prefix)) {
    return str.slice(prefix.length);
  }
}

// Answer by querying the cache. If fail, go to the network.
self.onfetch = function(event) {
  console.log("onfetch " + event.request.url);
  const dir = dirname(self.location.href);
  const path = removePrefix(event.request.url, dir);
  if (!path) {
    console.error("Failed to fetch url=" + event.request.url + " basePath=" + dir);
    event.respondWith(fetch(event.request).catch(() => new Response("")));
    return;
  }
  console.log("Fetching " + path);
  // https://circleci-mim-results.s3.eu-central-1.amazonaws.com/PR/4367/236734/elasticsearch_and_cassandra_mnesia.27.0.1-amd64/big.tar.gz
  const chunks = path.split("/");
  if (chunks.length < 5) {
    event.respondWith(fetch(event.request));
    return;
  }
  const [PR, PR_NUM, JOB_ID, JOB_NAME, FILENAME] = chunks;
  const tarPath = [PR, PR_NUM, JOB_ID, JOB_NAME, FILENAME].join("/");

  const rest = chunks.slice(5);
  const fileInArchive0 = rest.join("/");
  // Ignore labels #
  const [fileInArchive1] = fileInArchive0.split("?");
  const [fileInArchive] = fileInArchive1.split("#");
  

  console.log("tarPath=" + tarPath + " fileInArchive="+ fileInArchive);

  const zipPromise = downloadIfNotCached("CACHE:" + tarPath, dir, tarPath);
  const respPromise = zipPromise.then(function(res) {
    const {cache, files} = res;
    if (files[fileInArchive]) {
      const info = files[fileInArchive];
      console.log("File info " + JSON.stringify(info));
      return readFile(dir, cache, info.offset, info.size, files.parts).then(function(blob) {
          return new Response(blob, { headers: {
              // As the zip says nothing about the nature of the file, we extract
              // this information from the file name.
              'Content-Type': getContentType(fileInArchive)
            }});
        });
    } else {
      return fetch(event.request);
    }
  });
  event.respondWith(respPromise);
  return;

  

  swListener.postMessage("onfetch " + event.request.url);
  event.respondWith(openCache().then(function(cache) {
    return cache.match(event.request).then(function(response) {
//    return response || fetch(event.request);
      if (response) return response;
      
      try {
        return fetch(event.request);
      } catch (e) {
        console.log("error in onfetch " + e);
        event.respondWith(new Response(""));
      }
    });
  }));
};

async function readFile(dir, cache, offset, size, parts) {
  console.log("readFile " + JSON.stringify({offset, size}));
  const chunks = [];
  console.dir(parts);
  for (let i = 0; i < parts.length; i++) {
      if (!size) break;

      const part = parts[i];
      const nextOffset = part.offset + part.size;
      if ((offset >= part.offset) && (offset < nextOffset)) {
        const partReq = await cache.match(dir + "/part" + i);
        if (!partReq) {
          console.error("Failed to get part " + i);
          return;
        }
        const ab = await partReq.arrayBuffer();
        console.log("arrayBuffer " + ab.byteLength);
        const partData = new Uint8Array(ab);
        console.dir(partData);
        console.log("matched part " + JSON.stringify({i, part, offset, nextOffset, size}));
        const start = offset - part.offset;
        const leftInPart = part.size - start;
        const end = start + Math.min(size, leftInPart);
        console.log("slice " + JSON.stringify({start, end, len: partData.length}));
        chunks.push(partData.slice(start, end)); // start, end
        size = Math.max(0, size - leftInPart);
        offset = nextOffset;
      }
  }
  console.dir(chunks);
  return mergeArrays(chunks);
}

/*
// This wrapper promisifies the zip.js API for reading a zip.
function getZipReader(blob) {
    const reader = new zip.ZipReader(new zip.BlobReader(blob));
    return cacheContents(reader);
}

// Use the reader to read each of the files inside the zip
// and put them into the offline cache.
function cacheContents(reader) {
  return new Promise(function(fulfill, reject) {
    reader.getEntries().then(function(entries) {
      console.log('Installing', entries.length, 'files from zip');
      var startTime = performance.now();

      swListener.postMessage('Installing ' + entries.length + ' files from zip');
      Promise.all(entries.map(cacheEntry)).then(function() {
        var endTime = performance.now();
        swListener.postMessage("Installed " + (endTime - startTime) + " milliseconds");
        fulfill();
      }, reject);
    });
  });
}

// Cache one entry, skipping directories.
function cacheEntry(entry) {
  if (entry.directory) { return Promise.resolve(); }
  self.lastEntry = entry;
    // The writer specifies the format for the data to be read as.
    // This case, we want a generic blob as blob is one of the supported
    // formats for the `Response` constructor.
    return entry.getData(new zip.BlobWriter()).then(function(data) {
      return cacheBlob(entry.filename, data);
  });
}
*/

function cacheBlob(cache, filename, blob) {
//    return openCache().then(function(cache) {
        var location = getLocation(filename);
        var response = new Response(blob, { headers: {
          // As the zip says nothing about the nature of the file, we extract
          // this information from the file name.
          'Content-Type': getContentType(filename)
        } });

//      console.log('-> Caching', location, '(size:', blob.length, 'bytes)');
//      console.log('-> Caching', location);

        // If the entry is the index, cache its contents for root as well.
        if (filename === 'index.html') {
          // Response are one-use objects, as `.put()` consumes the data in the body
          // we need to clone the response in order to use it twice.
          cache.put(getLocation(), response.clone());
        }

        cache.put(location, response);
//    });
}

// Return the location for each entry.
function getLocation(filename) {
  return location.href.replace(/worker\.js$/, "big/" + (filename || ''));
}

var contentTypesByExtension = {
  'css': 'text/css',
  'js': 'application/javascript',
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'html': 'text/html',
  'htm': 'text/html'
};

// Return the content type of a file based on the name extension
function getContentType(filename) {
  var tokens = filename.split('.');
  var extension = tokens[tokens.length - 1];
  return contentTypesByExtension[extension] || 'text/plain';
}

// Opening a cache is an expensive operation. By caching the promise
// returned by `cache.open()` we only open the cache once.
var cachePromises = {};
function openCache(cacheName) {
  if (!cachePromises[cacheName]) { cachePromises[cacheName] = caches.open(cacheName); }
  return cachePromises[cacheName];
}
