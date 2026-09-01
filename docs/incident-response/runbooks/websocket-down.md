# Runbook: WebSocket Down

## Symptom Detection

### Automated Alerts
- Alert: `WebSocketDown`
- Condition: WebSocket connections failing > 0
- Threshold: > 5 connection failures per minute

### Manual Detection
- Users reporting: "Real-time updates not working"
- Frontend shows: "Disconnected" status
- No live data updates

## Diagnosis Steps

### Step 1: Check WebSocket Health
```bash
# Check WebSocket endpoint
curl -s http://localhost:3001/api/v1/health/ws | jq .

# Test WebSocket connection
wscat -c ws://localhost:3001/ws
```

### Step 2: Check Backend Process
```bash
# Check Node.js process
pm2 list

# Check WebSocket server logs
pm2 logs royalty-api --lines 50 | grep -i "websocket\|ws\|socket"
```

### Step 3: Check Network Configuration
```bash
# Check port usage
lsof -i :3001

# Check firewall rules
sudo iptables -L -n | grep 3001

# Check nginx/proxy configuration
cat /etc/nginx/conf.d/stellar-royalty.conf | grep -A5 "location /ws"
```

### Step 4: Check Client Connections
```bash
# Check active WebSocket connections
curl -s http://localhost:3001/api/v1/metrics | jq .websocketConnections

# Check connection history
pm2 logs royalty-api --lines 100 | grep -i "connect\|disconnect"
```

### Step 5: Check for Memory Issues
```bash
# Check memory usage
free -m

# Check for memory leaks
pm2 logs royalty-api --lines 100 | grep -i "memory\|heap\|gc"
```

## Recovery Steps

### Option 1: Restart WebSocket Server
```bash
# Restart backend (includes WebSocket)
pm2 restart royalty-api

# Monitor connections
watch -n 10 'curl -s http://localhost:3001/api/v1/metrics | jq .websocketConnections'
```

### Option 2: Check and Fix Proxy Configuration
```bash
# Check nginx configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Verify WebSocket headers
curl -s -I -H "Upgrade: websocket" -H "Connection: Upgrade" http://localhost:3001/ws
```

### Option 3: Increase Connection Limits
```bash
# Check system limits
ulimit -n

# Increase if needed
ulimit -n 65536

# Restart backend
pm2 restart royalty-api
```

### Option 4: Enable WebSocket Fallback
```bash
# Enable Server-Sent Events fallback
export SSE_FALLBACK_ENABLED=true
pm2 restart royalty-api
```

### Option 5: Check for DDoS
```bash
# Check connection count
netstat -an | grep :3001 | wc -l

# If suspicious, block IPs
sudo iptables -A INPUT -s <suspicious-ip> -j DROP
```

## Verification Steps

### Step 1: Test WebSocket Connection
```bash
# Using wscat
wscat -c ws://localhost:3001/ws

# Or using curl
curl -s -H "Upgrade: websocket" -H "Connection: Upgrade" http://localhost:3001/ws
```

### Step 2: Check Connection Metrics
```bash
curl -s http://localhost:3001/api/v1/metrics | jq .websocketConnections
# Expected: > 0 connections
```

### Step 3: Test Real-time Updates
```bash
# Open browser console
# Check for WebSocket connection
# Verify real-time updates are working
```

## Prevention

### Monitoring
- Set up alerts for connection failures
- Monitor connection count
- Track message delivery rate

### Best Practices
- Implement connection pooling
- Use heartbeats/pings
- Handle reconnection gracefully
- Monitor memory usage

## Time Estimates

| Step | Time |
|------|------|
| Diagnosis | 5-15 minutes |
| Recovery (Option 1) | 2-5 minutes |
| Recovery (Option 2) | 10-20 minutes |
| Recovery (Option 3) | 5-10 minutes |
| Recovery (Option 4) | 10-20 minutes |
| Recovery (Option 5) | 15-30 minutes |
| Verification | 5-10 minutes |

## Related Runbooks

- [High Error Rate](./high-error-rate.md)
- [Memory Leak](./memory-leak.md)
- [RPC Down](./rpc-down.md)
