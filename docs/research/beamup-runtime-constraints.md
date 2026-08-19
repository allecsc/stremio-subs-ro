# BeamUp Runtime Constraints: What Is Known and What Must Be Measured

**Research date:** 2026-08-16  
**Scope:** official Stremio BeamUp source and documentation only. This note does
not infer the live host's physical-machine specification from a template.

## Confirmed from the official BeamUp source

The current official BeamUp service generator creates one Docker Swarm service
per add-on. For both buildpack and Dockerfile applications, it gives that
service these resource settings:

| Resource | Service setting |
| --- | --- |
| CPU hard limit | 1.2 CPUs |
| Memory hard limit | 1,024 MiB |
| CPU reservation | 0.1 CPU |
| Memory reservation | 64 MiB |
| Restart policy | At most 10 restart attempts in a 5-minute window; 60-second delay |

Source: [`swarm-syncer/beamup-sync-swarm`](https://github.com/Stremio/stremio-beamup/blob/master/swarm-syncer/beamup-sync-swarm#L19-L57).

The same generator has a platform-wide maximum of 400 registered add-ons. That
is a platform capacity control, not a per-add-on memory budget.
Source: [`swarm-syncer/beamup-sync-swarm`](https://github.com/Stremio/stremio-beamup/blob/master/swarm-syncer/beamup-sync-swarm#L8-L10).

The generated app service definitions contain no app volume, disk quota,
storage reservation, or storage mount. BeamUp separately configures an Nginx
response-cache path with `max_size=1g` for each app, but that cache is outside
the addon's process and is not private application storage. These facts do not
establish any writable-disk allowance for the addon.
Source: [`swarm-syncer/beamup-sync-swarm`](https://github.com/Stremio/stremio-beamup/blob/master/swarm-syncer/beamup-sync-swarm#L15-L53), [`APP_NGINX_TMPL`](https://github.com/Stremio/stremio-beamup/blob/master/swarm-syncer/beamup-sync-swarm#L71-L72).

BeamUp's README describes a deployer plus a Docker Swarm and says the default
bootstrap has three Swarm nodes. It also explains that routing through container
ports is used for zero-downtime deployment. Therefore an old and new add-on
container may overlap during an update; container-local state is not a durable
or single-writer store.
Source: [BeamUp README](https://github.com/Stremio/stremio-beamup/blob/master/README.md#L225-L228), [architecture decision](https://github.com/Stremio/stremio-beamup/blob/master/README.md#L303-L306).

## What this means for the observed crash

The documented container ceiling is **1 GiB**, not 512 MiB. The previously
observed V8 fatal error near 516–518 MiB proves that the Node process exhausted
its JavaScript heap around that point. It does **not** prove that the Docker
container itself has a 512 MiB memory limit.

Those can coexist: Node can have a lower effective V8 heap ceiling than the
container's total memory limit, while Buffers, decompression work, and native
memory are accounted differently from ordinary JavaScript objects. We must
measure the process rather than call 512 MiB a host specification.

## Not confirmed for the live `baby-beamup` service

The official repository is the source of the default configuration. It is not
proof that the public host is on the current revision or that its operator has
not changed limits. The following remain unknown:

- the physical VM model, RAM, CPU, disk, and network allocation;
- which Swarm node runs this add-on at a given time;
- the exact live service resource limit/reservation;
- the Node version and effective V8 heap limit;
- whether this add-on has one task or an override;
- disk/volume availability for this add-on.

The maintainer's earlier freeze near 32 GB is therefore evidence of an
observed failure boundary on one node or writable layer, not a documented or
private 32 GB allowance. It must not be used as the cache budget.

The repository's `prod.tfvars.example` uses three Swarm nodes and a particular
provider plan, but it is an example configuration, **not evidence** about the
public host. Likewise, the local deployment guide's 8 CPU / 16 GB / 50 GB
machine is explicitly for running the BeamUp infrastructure locally, not an
individual add-on. Sources: [production example](https://github.com/Stremio/stremio-beamup/blob/master/terraform/prod/prod.tfvars.example#L20-L55), [local guide](https://github.com/Stremio/stremio-beamup/blob/master/local-deployment/README.md#L8-L18).

## How to establish the live constraints safely

This requires an operator-visible runtime inspection, not a production code
change and not a cache guess. The ideal evidence is:

1. `docker service inspect` of the live Swarm service: resource limits,
   reservations, restart policy, replica/task count, and image revision.
2. Inside the running container: cgroup memory and CPU limits, Node version,
   and V8's effective heap limit.
3. A short time series during a representative subtitle request: process RSS,
   V8 heap used/limit, external memory, and concurrent archive conversions.

The public BeamUp CLI documents add-on logs and restart operations, but it does
not document an end-user command that exposes the live Swarm service
inspection. Source: [BeamUp CLI README](https://github.com/Stremio/stremio-beamup-cli/blob/master/README.md#L212-L225).

Until the host operator exposes those facts, the **1 GiB / 1.2 CPU settings are
a documented default to test against, not a safe cache capacity target**.

## Decision implication for Ticket 01

This evidence supports measuring the real archive workflow before setting any
LRU byte budget, worker count, or archive-size rule. It does not support
loosening constraints merely because the physical Swarm may have more RAM: the
add-on is constrained by its own container and Node runtime.
