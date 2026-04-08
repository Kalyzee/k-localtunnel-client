// UDP frame codec for tunneling datagrams over TCP.
//
// Frame format:
//   [1 byte: type] [2 bytes: header length (BE)] [2 bytes: payload length (BE)] [header JSON] [payload]
//
// Frame types:
//   0x01 = DATA          — carries a UDP datagram
//   0x02 = SESSION_CLOSE — signals session end
//
// Header JSON for DATA:        { "addr": "1.2.3.4", "port": 12345 }
// Header JSON for SESSION_CLOSE: { "addr": "1.2.3.4", "port": 12345 }

const FRAME_DATA = 0x01;
const FRAME_SESSION_CLOSE = 0x02;
const HEADER_SIZE = 5; // 1 (type) + 2 (headerLen) + 2 (payloadLen)

function encodeFrame(type, header, payload) {
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const payloadBuf = payload ? Buffer.from(payload) : Buffer.alloc(0);
    const frame = Buffer.alloc(HEADER_SIZE + headerBuf.length + payloadBuf.length);

    frame.writeUInt8(type, 0);
    frame.writeUInt16BE(headerBuf.length, 1);
    frame.writeUInt16BE(payloadBuf.length, 3);
    headerBuf.copy(frame, HEADER_SIZE);
    payloadBuf.copy(frame, HEADER_SIZE + headerBuf.length);

    return frame;
}

function createFrameParser() {
    let buffer = Buffer.alloc(0);

    return function parse(chunk) {
        buffer = Buffer.concat([buffer, chunk]);
        const frames = [];

        while (buffer.length >= HEADER_SIZE) {
            const headerLen = buffer.readUInt16BE(1);
            const payloadLen = buffer.readUInt16BE(3);
            const totalLen = HEADER_SIZE + headerLen + payloadLen;

            if (buffer.length < totalLen) break;

            const type = buffer.readUInt8(0);
            const headerJson = buffer.slice(HEADER_SIZE, HEADER_SIZE + headerLen).toString('utf8');
            const payload = buffer.slice(HEADER_SIZE + headerLen, totalLen);

            let header;
            try {
                header = JSON.parse(headerJson);
            } catch (e) {
                // Skip malformed frame
                buffer = buffer.slice(totalLen);
                continue;
            }

            frames.push({ type, header, payload });
            buffer = buffer.slice(totalLen);
        }

        return frames;
    };
}

module.exports = { FRAME_DATA, FRAME_SESSION_CLOSE, encodeFrame, createFrameParser };
