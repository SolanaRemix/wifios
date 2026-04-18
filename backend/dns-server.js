'use strict';

const dns2 = require('dns2');
const { Packet } = dns2;

// IP to redirect ALL DNS queries to (your portal server)
const REDIRECT_IP = process.env.PORTAL_IP || '192.168.1.2';

const rawDnsPort = process.env.DNS_PORT;
const DNS_PORT = rawDnsPort === undefined ? 53 : Number.parseInt(rawDnsPort, 10);
if (!Number.isInteger(DNS_PORT) || DNS_PORT < 1 || DNS_PORT > 65535) {
  throw new Error(`Invalid DNS_PORT '${rawDnsPort}': must be an integer between 1 and 65535`);
}

const server = dns2.createServer({
  udp: true,
  handle: (request, send) => {
    const response = Packet.createResponseFromRequest(request);

    request.questions.forEach((question) => {
      response.answers.push({
        name: question.name,
        type: Packet.TYPE.A,
        class: Packet.CLASS.IN,
        ttl: 10, // short TTL so devices re-query quickly after paying
        address: REDIRECT_IP,
      });
    });

    send(response);
  },
});

server.on('error', (err) => {
  console.error('[dns-server] error:', err.message);
});

server.listen({ udp: DNS_PORT });
console.log(`🌐 DNS captive-portal server running on port ${DNS_PORT} → redirecting to ${REDIRECT_IP}`);
