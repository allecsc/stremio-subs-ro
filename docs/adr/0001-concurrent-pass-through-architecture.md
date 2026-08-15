# 0001: Concurrent Pass-Through Architecture

On shared multi-tenant hosting (such as BeamUp), the addon acts as a concurrent pass-through proxy rather than a global serialized rate-limiting queue. Global queuing with request cancellation (`clearQueues`) caused race conditions that broke key validation and other users' subtitle queries. Requests are dispatched concurrently using the caller's own API key, letting the upstream Subs.ro API manage individual account quotas while preventing cross-user request interference.
