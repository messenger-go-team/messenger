package main

import (
	"net"
	"sync"
)

// gRPC GracefulStop may wait for handlers while holding its server mutex.
// Track accepted connections so a shutdown deadline can close transports
// without waiting for that mutex or an application handler.
type grpcConnections struct {
	net.Listener
	mu     sync.Mutex
	conns  map[*grpcConnection]struct{}
	forced bool
}
type grpcConnection struct {
	net.Conn
	owner *grpcConnections
	once  sync.Once
}

func (l *grpcConnections) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked := &grpcConnection{Conn: c, owner: l}
	l.mu.Lock()
	if l.forced {
		l.mu.Unlock()
		_ = c.Close()
		return nil, net.ErrClosed
	}
	l.conns[tracked] = struct{}{}
	l.mu.Unlock()
	return tracked, nil
}
func (c *grpcConnection) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.conns, c); c.owner.mu.Unlock() })
	return err
}
func (l *grpcConnections) forceClose() {
	_ = l.Close()
	l.mu.Lock()
	l.forced = true
	conns := make([]*grpcConnection, 0, len(l.conns))
	for c := range l.conns {
		conns = append(conns, c)
	}
	l.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}
