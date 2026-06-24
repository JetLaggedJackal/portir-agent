# Portir Site Agent
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
# Provide config via a mounted file and AGENT_CONFIG, e.g.:
#   docker run -v /etc/portir/config.json:/config/config.json:ro \
#     -e AGENT_CONFIG=/config/config.json -v portir-agent-data:/app/agent/data portir-agent
ENV AGENT_CONFIG=/app/agent/config.json
CMD ["node", "agent/agent.js"]
