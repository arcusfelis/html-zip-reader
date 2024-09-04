// for debug
const forceDownload = false;

//var ZIP_URL = './big3.tar.gz';
//var ZIP_URL = './ct_report.tar.gz';
//var ZIP_URL = 'https://circleci-mim-results.s3.eu-central-1.amazonaws.com/PR/4367/236734/elasticsearch_and_cassandra_mnesia.27.0.1-amd64/big.tar.gz';
var ZIP_URL = 'http://localhost:8000/big3.tar.gz';

const ZIP_PREFIX = 'https://circleci-mim-results.s3.eu-central-1.amazonaws.com/';


const swListener = new BroadcastChannel('swListener');
swListener.postMessage("Importing scripts");

const SCOPE = "https://esl.github.io/html-zip-reader";

importScripts(SCOPE + '/lib/tar-web.js');
importScripts(SCOPE + '/lib/readable-web-to-node-stream.js');

//zip.configure({useWebWorkers: false, useCompressionStream: true});
swListener.postMessage("Scripts imported");

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
  swLog("worker.path=" + self.location.href);
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

function swLog(msg) {
  console.log(msg);
  swListener.postMessage(msg);
}

async function downloadZip(dir, cache, tarPath) {
  const startTime = performance.now();
  swLog("Downloading zip tarPath=" + tarPath);
//  const response = await fetch(ZIP_URL);

  const response = await fetch(ZIP_PREFIX + tarPath);
  const body = await response.body;
  swLog("Downloaded zip");
  const ds = new DecompressionStream("gzip");
  const decompressedStream = body.pipeThrough(ds);
  
  const [decompressedStream1, decompressedStream2] = decompressedStream.tee();

  const fetchTarPromise = fetchTar(decompressedStream1)
  const chunksReadyPromise = fetchStream(decompressedStream2, dir, cache);

  const files = await fetchTarPromise;
  const {parts, putPromises} = await chunksReadyPromise;
  await Promise.all(putPromises);
  swLog("Parts " + parts.length);

  const endTime = performance.now();
  swLog("Parsed TAR " + (endTime - startTime) + " milliseconds");
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
    swLog("Failed to find files list for " + cacheName);
    return;
  }
  const files = await filesReq.json();
  swLog("Got a list of files");
//console.dir(files);
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
          swLog("all entries read " + entriesCount);
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

//  swLog("got chunk " + value.length);

    if (value) {
      chunks.push(value);
      // value for fetch streams is a Uint8Array
      bytesReceived += value.length;
      absOffset += value.length;
    }

    if (((bytesReceived > PART_SIZE) || done) && bytesReceived) {
      // split logic
      swLog("Part received partSize=" + bytesReceived + " partOffset=" + partOffset);
      parts.push({size: bytesReceived, offset: partOffset});

      const putPromise = cache.put(dir + "/part" + (parts.length - 1), new Response(mergeArrays(chunks)));
      putPromises.push(putPromise);
      
      chunks = [];
      bytesReceived = 0;
      partOffset = absOffset;
    }

    if (done) {
      swLog("Stream complete");
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
  swLog("onfetch " + event.request.url);
  const dir = dirname(self.location.href);
  const path = removePrefix(event.request.url, dir);
  if (!path) {
    swLog("ERROR: Failed to fetch url=" + event.request.url + " basePath=" + dir);
    event.respondWith(fetch(event.request).catch(() => new Response("")));
    return;
  }
  swLog("Fetching " + path);
  // https://circleci-mim-results.s3.eu-central-1.amazonaws.com/PR/4367/236734/elasticsearch_and_cassandra_mnesia.27.0.1-amd64/big.tar.gz
  // Remove duplicate slashes
  const chunks = path.split("/").filter((x) => !!x.length);
  if (chunks.length < 5) {
    swLog("not enough chunks");
    event.respondWith(fetch(event.request));
    return;
  }
  swLog("Split path " + JSON.stringify(chunks));
  const [PR, PR_NUM, JOB_ID, JOB_NAME, FILENAME] = chunks;
  const tarPath = [PR, PR_NUM, JOB_ID, JOB_NAME, FILENAME].join("/");

  const rest = chunks.slice(5);
  const fileInArchive0 = rest.join("/");
  // Ignore labels #
  const [fileInArchive1] = fileInArchive0.split("?");
  const [fileInArchive] = fileInArchive1.split("#");

  if (!fileInArchive) {
    const to = dir + "/" + tarPath + "/index.html";
    swLog("redirect to " + to);
    // Redirect so paths for relative files work correctly
    event.respondWith(Response.redirect(to));
    return;
  }

  swLog("tarPath=" + tarPath + " fileInArchive="+ fileInArchive);

  const zipPromise = downloadIfNotCached("CACHE:" + tarPath, dir, tarPath);
  const respPromise = zipPromise.then(function(res) {
    const {cache, files} = res;
    if (files[fileInArchive]) {
      const info = files[fileInArchive];
      swLog("File info " + JSON.stringify(info));
      return readFile(dir, cache, info.offset, info.size, files.parts).then(function(blob) {
          return new Response(blob, { headers: {
              // As the zip says nothing about the nature of the file, we extract
              // this information from the file name.
              'Content-Type': getContentType(fileInArchive)
            }});
        });
    } else {
      // Return something, so we do not loop forever
      return new Response("Oops, file not found");
    }
  });
  event.respondWith(respPromise);
  return;

  

  swLog("onfetch " + event.request.url);
  event.respondWith(openCache().then(function(cache) {
    return cache.match(event.request).then(function(response) {
//    return response || fetch(event.request);
      if (response) return response;
      
      try {
        return fetch(event.request);
      } catch (e) {
        swLog("error in onfetch " + e);
        event.respondWith(new Response(""));
      }
    });
  }));
};

async function readFile(dir, cache, offset, size, parts) {
  swLog("readFile " + JSON.stringify({offset, size}));
  const chunks = [];
//console.dir(parts);
  for (let i = 0; i < parts.length; i++) {
      if (!size) break;

      const part = parts[i];
      const nextOffset = part.offset + part.size;
      if ((offset >= part.offset) && (offset < nextOffset)) {
        const partReq = await cache.match(dir + "/part" + i);
        if (!partReq) {
          swLog("ERROR: Failed to get part " + i);
          return;
        }
        const ab = await partReq.arrayBuffer();
        swLog("arrayBuffer " + ab.byteLength);
        const partData = new Uint8Array(ab);
//      console.dir(partData);
        swLog("matched part " + JSON.stringify({i, part, offset, nextOffset, size}));
        const start = offset - part.offset;
        const leftInPart = part.size - start;
        const end = start + Math.min(size, leftInPart);
        swLog("slice " + JSON.stringify({start, end, len: partData.length}));
        chunks.push(partData.slice(start, end)); // start, end
        size = Math.max(0, size - leftInPart);
        offset = nextOffset;
      }
  }
//console.dir(chunks);
  return mergeArrays(chunks);
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
