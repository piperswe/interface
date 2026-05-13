// Zod schemas for every component defined in the Fly.io Machines API OpenAPI
// spec. Names follow the pattern: spec name `fly.MachineConfig` →
// `flyMachineConfigSchema` / `FlyMachineConfig` (dots become camelCase).
//
// Schemas describe all fields from the spec. Unknown extra fields from the
// API are stripped at parse time (Zod default object behaviour), so API
// additions don't break callers.

import { z } from 'zod';

// ----- Primitives / enums -------------------------------------------------

export const flySignalSchema = z.enum(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGUSR1', 'SIGUSR2', 'SIGTERM']);
export type FlySignal = z.infer<typeof flySignalSchema>;

export const flyStopSignalSchema = z.enum([
	'SIGABRT',
	'SIGALRM',
	'SIGFPE',
	'SIGHUP',
	'SIGILL',
	'SIGINT',
	'SIGKILL',
	'SIGPIPE',
	'SIGQUIT',
	'SIGSEGV',
	'SIGTERM',
	'SIGTRAP',
	'SIGUSR1',
	'SIGUSR2',
]);
export type FlyStopSignal = z.infer<typeof flyStopSignalSchema>;

// Machine wait endpoint allows a subset of states as the target.
export const flyWaitStateSchema = z.enum(['started', 'stopped', 'suspended', 'destroyed', 'failed', 'settled']);
export type FlyWaitState = z.infer<typeof flyWaitStateSchema>;

export const flyHostStatusSchema = z.enum(['ok', 'unknown', 'unreachable']);
export type FlyHostStatus = z.infer<typeof flyHostStatusSchema>;

// ----- Shared small types -------------------------------------------------

export const flyImageRefSchema = z.object({
	digest: z.string().optional(),
	labels: z.record(z.string(), z.string()).optional(),
	registry: z.string().optional(),
	repository: z.string().optional(),
	tag: z.string().optional(),
});
export type FlyImageRef = z.infer<typeof flyImageRefSchema>;

export const flyCheckStatusSchema = z.object({
	name: z.string().optional(),
	output: z.string().optional(),
	status: z.string().optional(),
	updated_at: z.string().optional(),
});
export type FlyCheckStatus = z.infer<typeof flyCheckStatusSchema>;

export const flyMachineEventSchema = z.object({
	id: z.string().optional(),
	request: z.unknown().optional(),
	source: z.string().optional(),
	status: z.string().optional(),
	timestamp: z.number().int().optional(),
	type: z.string().optional(),
});
export type FlyMachineEvent = z.infer<typeof flyMachineEventSchema>;

// ----- fly.MachineGuest ---------------------------------------------------

export const flyMachineGuestSchema = z.object({
	cpu_kind: z.string().optional(),
	cpus: z.number().int().optional(),
	gpu_kind: z.string().optional(),
	gpus: z.number().int().optional(),
	host_dedication_id: z.string().optional(),
	kernel_args: z.array(z.string()).optional(),
	max_memory_mb: z.number().int().optional(),
	memory_mb: z.number().int().optional(),
	persist_rootfs: z.enum(['never', 'always', 'restart']).optional(),
});
export type FlyMachineGuest = z.infer<typeof flyMachineGuestSchema>;

// ----- fly.MachineHTTPHeader ----------------------------------------------

export const flyMachineHTTPHeaderSchema = z.object({
	name: z.string().optional(),
	values: z.array(z.string()).optional(),
});
export type FlyMachineHTTPHeader = z.infer<typeof flyMachineHTTPHeaderSchema>;

// ----- fly.MachineRestart -------------------------------------------------

export const flyMachineRestartSchema = z.object({
	gpu_bid_price: z.number().optional(),
	max_retries: z.number().int().optional(),
	policy: z.enum(['no', 'always', 'on-failure', 'spot-price']).optional(),
});
export type FlyMachineRestart = z.infer<typeof flyMachineRestartSchema>;

// ----- fly.StopConfig -----------------------------------------------------

export const flyStopConfigSchema = z.object({
	signal: flySignalSchema.optional(),
	timeout: z.string().optional(),
});
export type FlyStopConfig = z.infer<typeof flyStopConfigSchema>;

// ----- fly.MachineSecret --------------------------------------------------

export const flyMachineSecretSchema = z.object({
	env_var: z.string().optional(),
	name: z.string().optional(),
});
export type FlyMachineSecret = z.infer<typeof flyMachineSecretSchema>;

// ----- fly.EnvFrom --------------------------------------------------------

export const flyEnvFromSchema = z.object({
	env_var: z.string().optional(),
	field_ref: z.enum(['id', 'version', 'app_name', 'private_ip', 'region', 'image']).optional(),
});
export type FlyEnvFrom = z.infer<typeof flyEnvFromSchema>;

// ----- fly.File -----------------------------------------------------------

export const flyFileSchema = z.object({
	guest_path: z.string().optional(),
	image_config: z.string().optional(),
	mode: z.number().int().optional(),
	raw_value: z.string().optional(),
	secret_name: z.string().optional(),
});
export type FlyFile = z.infer<typeof flyFileSchema>;

// ----- fly.DNSConfig ------------------------------------------------------

export const flyDnsForwardRuleSchema = z.object({
	addr: z.string().optional(),
	basename: z.string().optional(),
});

export const flyDnsOptionSchema = z.object({
	name: z.string().optional(),
	value: z.string().optional(),
});

export const flyDNSConfigSchema = z.object({
	dns_forward_rules: z.array(flyDnsForwardRuleSchema).optional(),
	hostname: z.string().optional(),
	hostname_fqdn: z.string().optional(),
	nameservers: z.array(z.string()).optional(),
	options: z.array(flyDnsOptionSchema).optional(),
	searches: z.array(z.string()).optional(),
	skip_registration: z.boolean().optional(),
});
export type FlyDNSConfig = z.infer<typeof flyDNSConfigSchema>;

// ----- fly.MachineCheck ---------------------------------------------------

export const flyMachineCheckSchema = z.object({
	grace_period: z.string().optional(),
	headers: z.array(flyMachineHTTPHeaderSchema).optional(),
	interval: z.string().optional(),
	kind: z.enum(['informational', 'readiness']).optional(),
	method: z.string().optional(),
	path: z.string().optional(),
	port: z.number().int().optional(),
	protocol: z.string().optional(),
	timeout: z.string().optional(),
	tls_server_name: z.string().optional(),
	tls_skip_verify: z.boolean().optional(),
	type: z.string().optional(),
});
export type FlyMachineCheck = z.infer<typeof flyMachineCheckSchema>;

// ----- fly.MachineServiceCheck / Concurrency ------------------------------

export const flyMachineServiceCheckSchema = z.object({
	grace_period: z.string().optional(),
	headers: z.array(flyMachineHTTPHeaderSchema).optional(),
	interval: z.string().optional(),
	method: z.string().optional(),
	path: z.string().optional(),
	port: z.number().int().optional(),
	protocol: z.string().optional(),
	timeout: z.string().optional(),
	tls_server_name: z.string().optional(),
	tls_skip_verify: z.boolean().optional(),
	type: z.string().optional(),
});

export const flyMachineServiceConcurrencySchema = z.object({
	hard_limit: z.number().int().optional(),
	soft_limit: z.number().int().optional(),
	type: z.string().optional(),
});

// ----- fly.HTTPOptions / fly.HTTPResponseOptions / fly.ReplayCache --------

export const flyReplayCacheSchema = z.object({
	allow_bypass: z.boolean().optional(),
	name: z.string().optional(),
	path_prefix: z.string().optional(),
	ttl_seconds: z.number().int().optional(),
	type: z.enum(['cookie', 'header']).optional(),
});

export const flyHTTPResponseOptionsSchema = z.object({
	headers: z.record(z.string(), z.unknown()).optional(),
	pristine: z.boolean().optional(),
});

export const flyHTTPOptionsSchema = z.object({
	compress: z.boolean().optional(),
	h2_backend: z.boolean().optional(),
	headers_read_timeout: z.number().int().optional(),
	idle_timeout: z.number().int().optional(),
	replay_cache: z.array(flyReplayCacheSchema).optional(),
	response: flyHTTPResponseOptionsSchema.optional(),
});

// ----- fly.TLSOptions / fly.ProxyProtoOptions -----------------------------

export const flyTLSOptionsSchema = z.object({
	alpn: z.array(z.string()).optional(),
	default_self_signed: z.boolean().optional(),
	versions: z.array(z.string()).optional(),
});

export const flyProxyProtoOptionsSchema = z.object({
	version: z.string().optional(),
});

// ----- fly.MachinePort ----------------------------------------------------

export const flyMachinePortSchema = z.object({
	end_port: z.number().int().optional(),
	force_https: z.boolean().optional(),
	handlers: z.array(z.string()).optional(),
	http_options: flyHTTPOptionsSchema.optional(),
	port: z.number().int().optional(),
	proxy_proto_options: flyProxyProtoOptionsSchema.optional(),
	start_port: z.number().int().optional(),
	tls_options: flyTLSOptionsSchema.optional(),
});
export type FlyMachinePort = z.infer<typeof flyMachinePortSchema>;

// ----- fly.MachineService -------------------------------------------------

export const flyMachineServiceSchema = z.object({
	autostart: z.boolean().optional(),
	autostop: z.enum(['off', 'stop', 'suspend']).optional(),
	checks: z.array(flyMachineServiceCheckSchema).optional(),
	concurrency: flyMachineServiceConcurrencySchema.optional(),
	force_instance_description: z.string().optional(),
	force_instance_key: z.string().optional(),
	internal_port: z.number().int().optional(),
	min_machines_running: z.number().int().optional(),
	ports: z.array(flyMachinePortSchema).optional(),
	protocol: z.string().optional(),
});
export type FlyMachineService = z.infer<typeof flyMachineServiceSchema>;

// ----- fly.MachineMount ---------------------------------------------------

export const flyMachineMountSchema = z.object({
	add_size_gb: z.number().int().optional(),
	encrypted: z.boolean().optional(),
	extend_threshold_percent: z.number().int().optional(),
	name: z.string().optional(),
	path: z.string().optional(),
	size_gb: z.number().int().optional(),
	size_gb_limit: z.number().int().optional(),
	volume: z.string().optional(),
});
export type FlyMachineMount = z.infer<typeof flyMachineMountSchema>;

// ----- fly.MachineInit ----------------------------------------------------

export const flyMachineInitSchema = z.object({
	cmd: z.array(z.string()).optional(),
	entrypoint: z.array(z.string()).optional(),
	exec: z.array(z.string()).optional(),
	kernel_args: z.array(z.string()).optional(),
	swap_size_mb: z.number().int().optional(),
	tty: z.boolean().optional(),
});
export type FlyMachineInit = z.infer<typeof flyMachineInitSchema>;

// ----- fly.MachineMetrics -------------------------------------------------

export const flyMachineMetricsSchema = z.object({
	https: z.boolean().optional(),
	path: z.string().optional(),
	port: z.number().int().optional(),
});
export type FlyMachineMetrics = z.infer<typeof flyMachineMetricsSchema>;

// ----- fly.MachineProcess -------------------------------------------------

export const flyMachineProcessSchema = z.object({
	cmd: z.array(z.string()).optional(),
	entrypoint: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	env_from: z.array(flyEnvFromSchema).optional(),
	exec: z.array(z.string()).optional(),
	ignore_app_secrets: z.boolean().optional(),
	secrets: z.array(flyMachineSecretSchema).optional(),
	user: z.string().optional(),
});
export type FlyMachineProcess = z.infer<typeof flyMachineProcessSchema>;

// ----- fly.MachineRootfs --------------------------------------------------

export const flyMachineRootfsSchema = z.object({
	persist: z.enum(['never', 'always', 'restart']).optional(),
	size_gb: z.number().int().optional(),
});
export type FlyMachineRootfs = z.infer<typeof flyMachineRootfsSchema>;

// ----- fly.Static ---------------------------------------------------------

export const flyStaticSchema = z.object({
	guest_path: z.string(),
	index_document: z.string().optional(),
	tigris_bucket: z.string().optional(),
	url_prefix: z.string(),
});
export type FlyStatic = z.infer<typeof flyStaticSchema>;

// ----- fly.MachineCacheDrive ----------------------------------------------

export const flyMachineCacheDriveSchema = z.object({
	size_mb: z.number().int().optional(),
});

// ----- fly.ContainerDependencyCondition / ContainerDependency -------------

export const flyContainerDependencyConditionSchema = z.enum(['exited_successfully', 'healthy', 'started']);

export const flyContainerDependencySchema = z.object({
	condition: flyContainerDependencyConditionSchema.optional(),
	name: z.string().optional(),
});

// ----- fly.ContainerHealthcheck -------------------------------------------

export const flyContainerHealthcheckKindSchema = z.enum(['readiness', 'liveness']);
export const flyContainerHealthcheckSchemeSchema = z.enum(['http', 'https']);
export const flyUnhealthyPolicySchema = z.literal('stop');

export const flyExecHealthcheckSchema = z.object({
	command: z.array(z.string()).optional(),
});

export const flyHTTPHealthcheckSchema = z.object({
	headers: z.array(flyMachineHTTPHeaderSchema).optional(),
	method: z.string().optional(),
	path: z.string().optional(),
	port: z.number().int().optional(),
	scheme: flyContainerHealthcheckSchemeSchema.optional(),
	tls_server_name: z.string().optional(),
	tls_skip_verify: z.boolean().optional(),
});

export const flyTCPHealthcheckSchema = z.object({
	port: z.number().int().optional(),
});

export const flyContainerHealthcheckSchema = z.object({
	exec: flyExecHealthcheckSchema.optional(),
	failure_threshold: z.number().int().optional(),
	grace_period: z.number().int().optional(),
	http: flyHTTPHealthcheckSchema.optional(),
	interval: z.number().int().optional(),
	kind: flyContainerHealthcheckKindSchema.optional(),
	name: z.string().optional(),
	success_threshold: z.number().int().optional(),
	tcp: flyTCPHealthcheckSchema.optional(),
	timeout: z.number().int().optional(),
	unhealthy: flyUnhealthyPolicySchema.optional(),
});

// ----- fly.ContainerConfig ------------------------------------------------

export const flyContainerConfigSchema = z.object({
	cmd: z.array(z.string()).optional(),
	depends_on: z.array(flyContainerDependencySchema).optional(),
	entrypoint: z.array(z.string()).optional(),
	env: z.record(z.string(), z.string()).optional(),
	env_from: z.array(flyEnvFromSchema).optional(),
	exec: z.array(z.string()).optional(),
	files: z.array(flyFileSchema).optional(),
	healthchecks: z.array(flyContainerHealthcheckSchema).optional(),
	image: z.string().optional(),
	name: z.string().optional(),
	restart: flyMachineRestartSchema.optional(),
	secrets: z.array(flyMachineSecretSchema).optional(),
	stop: flyStopConfigSchema.optional(),
	user: z.string().optional(),
});
export type FlyContainerConfig = z.infer<typeof flyContainerConfigSchema>;

// ----- fly.MachineConfig --------------------------------------------------

export const flyMachineConfigSchema = z.object({
	auto_destroy: z.boolean().optional(),
	cache_drive: flyMachineCacheDriveSchema.optional(),
	checks: z.record(z.string(), flyMachineCheckSchema).optional(),
	containers: z.array(flyContainerConfigSchema).optional(),
	disable_machine_autostart: z.boolean().optional(),
	dns: flyDNSConfigSchema.optional(),
	env: z.record(z.string(), z.string()).optional(),
	files: z.array(flyFileSchema).optional(),
	guest: flyMachineGuestSchema.optional(),
	image: z.string().optional(),
	init: flyMachineInitSchema.optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	metrics: flyMachineMetricsSchema.optional(),
	mounts: z.array(flyMachineMountSchema).optional(),
	processes: z.array(flyMachineProcessSchema).optional(),
	restart: flyMachineRestartSchema.optional(),
	rootfs: flyMachineRootfsSchema.optional(),
	schedule: z.string().optional(),
	services: z.array(flyMachineServiceSchema).optional(),
	size: z.string().optional(),
	standbys: z.array(z.string()).optional(),
	statics: z.array(flyStaticSchema).optional(),
	stop_config: flyStopConfigSchema.optional(),
});
export type FlyMachineConfig = z.infer<typeof flyMachineConfigSchema>;

// ----- Machine (full response object) -------------------------------------

export const flyMachineSchema = z.object({
	checks: z.array(flyCheckStatusSchema).optional(),
	config: flyMachineConfigSchema.optional(),
	created_at: z.string().optional(),
	events: z.array(flyMachineEventSchema).optional(),
	host_status: flyHostStatusSchema.optional(),
	id: z.string(),
	image_ref: flyImageRefSchema.optional(),
	incomplete_config: flyMachineConfigSchema.optional(),
	instance_id: z.string().optional(),
	name: z.string().optional(),
	nonce: z.string().optional(),
	private_ip: z.string().optional(),
	region: z.string().optional(),
	// The spec declares state as a plain string (not a constrained enum).
	state: z.string(),
	updated_at: z.string().optional(),
});
export type FlyMachine = z.infer<typeof flyMachineSchema>;

// ----- CreateMachineRequest / UpdateMachineRequest ------------------------

export const createMachineRequestSchema = z.object({
	config: flyMachineConfigSchema.optional(),
	lease_ttl: z.number().int().optional(),
	lsvd: z.boolean().optional(),
	min_secrets_version: z.number().int().optional(),
	name: z.string().optional(),
	region: z.string().optional(),
	skip_launch: z.boolean().optional(),
	skip_secrets: z.boolean().optional(),
	skip_service_registration: z.boolean().optional(),
});
export type CreateMachineRequest = z.infer<typeof createMachineRequestSchema>;

export const updateMachineRequestSchema = z.object({
	config: flyMachineConfigSchema.optional(),
	current_version: z.string().optional(),
	lease_ttl: z.number().int().optional(),
	lsvd: z.boolean().optional(),
	min_secrets_version: z.number().int().optional(),
	name: z.string().optional(),
	region: z.string().optional(),
	skip_launch: z.boolean().optional(),
	skip_secrets: z.boolean().optional(),
	skip_service_registration: z.boolean().optional(),
});
export type UpdateMachineRequest = z.infer<typeof updateMachineRequestSchema>;

// ----- MachineExecRequest / ExecResponse ----------------------------------

export const machineExecRequestSchema = z.object({
	command: z.array(z.string()).min(1),
	container: z.string().optional(),
	stdin: z.string().optional(),
	timeout: z.number().int().positive().optional(),
});
export type MachineExecRequest = z.infer<typeof machineExecRequestSchema>;

export const execResponseSchema = z.object({
	exit_code: z.number().int(),
	exit_signal: z.number().int().optional(),
	stderr: z
		.string()
		.nullable()
		.optional()
		.transform((v) => v ?? ''),
	stdout: z
		.string()
		.nullable()
		.optional()
		.transform((v) => v ?? ''),
});
export type ExecResponse = z.infer<typeof execResponseSchema>;

// ----- MachineVersion -----------------------------------------------------

export const machineVersionSchema = z.object({
	user_config: flyMachineConfigSchema.optional(),
	version: z.string().optional(),
});
export type MachineVersion = z.infer<typeof machineVersionSchema>;

// ----- MachineOverviewConfig / OrgMachine ---------------------------------

export const machineOverviewConfigSchema = z.object({
	guest: flyMachineGuestSchema.optional(),
	image: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
});

export const orgMachineSchema = z.object({
	app_name: z.string().optional(),
	config: machineOverviewConfigSchema.optional(),
	created_at: z.string().optional(),
	id: z.string().optional(),
	name: z.string().optional(),
	private_ip: z.string().optional(),
	region: z.string().optional(),
	state: z.string().optional(),
	updated_at: z.string().optional(),
	version: z.string().optional(),
});
export type OrgMachine = z.infer<typeof orgMachineSchema>;

export const orgMachinesResponseSchema = z.object({
	error_regions: z.array(z.string()).optional(),
	last_machine_id: z.string().optional(),
	last_updated_at: z.string().optional(),
	machines: z.array(orgMachineSchema).optional(),
	next_cursor: z.string().optional(),
});
export type OrgMachinesResponse = z.infer<typeof orgMachinesResponseSchema>;

// ----- Lease --------------------------------------------------------------

export const leaseSchema = z.object({
	description: z.string().optional(),
	expires_at: z.number().int().optional(),
	nonce: z.string().optional(),
	owner: z.string().optional(),
	version: z.string().optional(),
});
export type Lease = z.infer<typeof leaseSchema>;

export const createLeaseRequestSchema = z.object({
	description: z.string().optional(),
	ttl: z.number().int().optional(),
});
export type CreateLeaseRequest = z.infer<typeof createLeaseRequestSchema>;

// ----- WaitMachineResponse ------------------------------------------------

export const waitMachineResponseSchema = z.object({
	event_id: z.string().optional(),
	ok: z.boolean().optional(),
	state: z.string().optional(),
	version: z.string().optional(),
});
export type WaitMachineResponse = z.infer<typeof waitMachineResponseSchema>;

// ----- ProcessStat --------------------------------------------------------

export const listenSocketSchema = z.object({
	address: z.string().optional(),
	proto: z.string().optional(),
});

export const processStatSchema = z.object({
	command: z.string().optional(),
	cpu: z.number().int().optional(),
	directory: z.string().optional(),
	listen_sockets: z.array(listenSocketSchema).optional(),
	pid: z.number().int().optional(),
	rss: z.number().int().optional(),
	rtime: z.number().int().optional(),
	stime: z.number().int().optional(),
});
export type ProcessStat = z.infer<typeof processStatSchema>;

// ----- Memory endpoints ---------------------------------------------------

export const memoryResponseSchema = z.object({
	available_mb: z.number().int().optional(),
	limit_mb: z.number().int().optional(),
});
export type MemoryResponse = z.infer<typeof memoryResponseSchema>;

export const setMemoryLimitRequestSchema = z.object({
	limit_mb: z.number().int().optional(),
});
export type SetMemoryLimitRequest = z.infer<typeof setMemoryLimitRequestSchema>;

export const reclaimMemoryRequestSchema = z.object({
	amount_mb: z.number().int().optional(),
});
export type ReclaimMemoryRequest = z.infer<typeof reclaimMemoryRequestSchema>;

export const reclaimMemoryResponseSchema = z.object({
	actual_mb: z.number().int().optional(),
});
export type ReclaimMemoryResponse = z.infer<typeof reclaimMemoryResponseSchema>;

// ----- Metadata endpoints -------------------------------------------------

export const updateMetadataRequestSchema = z.object({
	machine_version: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	updated_at: z.string().optional(),
});
export type UpdateMetadataRequest = z.infer<typeof updateMetadataRequestSchema>;

export const upsertMetadataKeyRequestSchema = z.object({
	updated_at: z.string().optional(),
	value: z.string().optional(),
});
export type UpsertMetadataKeyRequest = z.infer<typeof upsertMetadataKeyRequestSchema>;

export const metadataValueResponseSchema = z.object({
	value: z.string().optional(),
});
export type MetadataValueResponse = z.infer<typeof metadataValueResponseSchema>;

// ----- Signal / Stop / StopRequest ----------------------------------------

export const signalRequestSchema = z.object({
	signal: flyStopSignalSchema.optional(),
});
export type SignalRequest = z.infer<typeof signalRequestSchema>;

export const stopRequestSchema = z.object({
	signal: flySignalSchema.optional(),
	timeout: z.string().optional(),
});
export type StopRequest = z.infer<typeof stopRequestSchema>;

// ----- App / AppOrganizationInfo ------------------------------------------

export const appOrganizationInfoSchema = z.object({
	internal_numeric_id: z.number().int().optional(),
	name: z.string().optional(),
	slug: z.string().optional(),
});

export const appSchema = z.object({
	id: z.string().optional(),
	internal_numeric_id: z.number().int().optional(),
	machine_count: z.number().int().optional(),
	name: z.string().optional(),
	network: z.string().optional(),
	organization: appOrganizationInfoSchema.optional(),
	status: z.string().optional(),
	volume_count: z.number().int().optional(),
});
export type App = z.infer<typeof appSchema>;

export const listAppsResponseSchema = z.object({
	apps: z.array(appSchema).optional(),
	total_apps: z.number().int().optional(),
});
export type ListAppsResponse = z.infer<typeof listAppsResponseSchema>;

export const createAppRequestSchema = z.object({
	enable_subdomains: z.boolean().optional(),
	name: z.string().optional(),
	network: z.string().optional(),
	org_slug: z.string().optional(),
});
export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;

export const createAppResponseSchema = z.object({
	token: z.string().optional(),
});
export type CreateAppResponse = z.infer<typeof createAppResponseSchema>;

export const createAppDeployTokenRequestSchema = z.object({
	expiry: z.string().optional(),
});
export type CreateAppDeployTokenRequest = z.infer<typeof createAppDeployTokenRequestSchema>;

// ----- IPAssignment -------------------------------------------------------

export const iPAssignmentSchema = z.object({
	created_at: z.string().optional(),
	ip: z.string().optional(),
	region: z.string().optional(),
	service_name: z.string().optional(),
	shared: z.boolean().optional(),
});
export type IPAssignment = z.infer<typeof iPAssignmentSchema>;

export const listIPAssignmentsResponseSchema = z.object({
	ips: z.array(iPAssignmentSchema).optional(),
});

export const assignIPRequestSchema = z.object({
	network: z.string().optional(),
	org_slug: z.string().optional(),
	region: z.string().optional(),
	service_name: z.string().optional(),
	type: z.string().optional(),
});
export type AssignIPRequest = z.infer<typeof assignIPRequestSchema>;

// ----- Volume / VolumeSnapshot --------------------------------------------

export const volumeSchema = z.object({
	attached_alloc_id: z.string().optional(),
	attached_machine_id: z.string().optional(),
	auto_backup_enabled: z.boolean().optional(),
	block_size: z.number().int().optional(),
	blocks: z.number().int().optional(),
	blocks_avail: z.number().int().optional(),
	blocks_free: z.number().int().optional(),
	bytes_total: z.number().int().optional(),
	bytes_used: z.number().int().optional(),
	created_at: z.string().optional(),
	encrypted: z.boolean().optional(),
	fstype: z.string().optional(),
	host_status: flyHostStatusSchema.optional(),
	id: z.string().optional(),
	name: z.string().optional(),
	region: z.string().optional(),
	size_gb: z.number().int().optional(),
	snapshot_retention: z.number().int().optional(),
	state: z.string().optional(),
	type: z.enum(['local', 'cache']).optional(),
	zone: z.string().optional(),
});
export type Volume = z.infer<typeof volumeSchema>;

export const volumeSnapshotSchema = z.object({
	created_at: z.string().optional(),
	digest: z.string().optional(),
	id: z.string().optional(),
	retention_days: z.number().int().optional(),
	size: z.number().int().optional(),
	status: z.string().optional(),
	volume_size: z.number().int().optional(),
});
export type VolumeSnapshot = z.infer<typeof volumeSnapshotSchema>;

export const createVolumeRequestSchema = z.object({
	auto_backup_enabled: z.boolean().optional(),
	compute: flyMachineGuestSchema.optional(),
	compute_image: z.string().optional(),
	encrypted: z.boolean().optional(),
	fstype: z.string().optional(),
	name: z.string().optional(),
	region: z.string().optional(),
	require_unique_zone: z.boolean().optional(),
	size_gb: z.number().int().optional(),
	snapshot_id: z.string().optional(),
	snapshot_retention: z.number().int().optional(),
	source_volume_id: z.string().optional(),
	unique_zone_app_wide: z.boolean().optional(),
});
export type CreateVolumeRequest = z.infer<typeof createVolumeRequestSchema>;

export const updateVolumeRequestSchema = z.object({
	auto_backup_enabled: z.boolean().optional(),
	snapshot_retention: z.number().int().optional(),
});
export type UpdateVolumeRequest = z.infer<typeof updateVolumeRequestSchema>;

export const extendVolumeRequestSchema = z.object({
	size_gb: z.number().int().optional(),
});
export type ExtendVolumeRequest = z.infer<typeof extendVolumeRequestSchema>;

export const extendVolumeResponseSchema = z.object({
	needs_restart: z.boolean().optional(),
	volume: volumeSchema.optional(),
});
export type ExtendVolumeResponse = z.infer<typeof extendVolumeResponseSchema>;

export const orgVolumeSchema = z.object({
	app_name: z.string().optional(),
	attached_alloc_id: z.string().optional(),
	attached_machine_id: z.string().optional(),
	auto_backup_enabled: z.boolean().optional(),
	block_size: z.number().int().optional(),
	blocks: z.number().int().optional(),
	blocks_avail: z.number().int().optional(),
	blocks_free: z.number().int().optional(),
	bytes_total: z.number().int().optional(),
	bytes_used: z.number().int().optional(),
	created_at: z.string().optional(),
	encrypted: z.boolean().optional(),
	fstype: z.string().optional(),
	host_status: flyHostStatusSchema.optional(),
	id: z.string().optional(),
	name: z.string().optional(),
	region: z.string().optional(),
	size_gb: z.number().int().optional(),
	snapshot_retention: z.number().int().optional(),
	state: z.string().optional(),
	type: z.enum(['local', 'cache']).optional(),
	updated_at: z.string().optional(),
	zone: z.string().optional(),
});
export type OrgVolume = z.infer<typeof orgVolumeSchema>;

export const orgVolumesResponseSchema = z.object({
	last_updated_at: z.string().optional(),
	last_volume_id: z.string().optional(),
	next_cursor: z.string().optional(),
	volumes: z.array(orgVolumeSchema).optional(),
});
export type OrgVolumesResponse = z.infer<typeof orgVolumesResponseSchema>;

// ----- Certificates -------------------------------------------------------

export const acmeChallengeSchema = z.object({
	name: z.string().optional(),
	target: z.string().optional(),
});

export const ownershipVerificationSchema = z.object({
	app_value: z.string().optional(),
	name: z.string().optional(),
	org_value: z.string().optional(),
});

export const dnsRecordsSchema = z.object({
	a: z.array(z.string()).optional(),
	aaaa: z.array(z.string()).optional(),
	acme_challenge_cname: z.string().optional(),
	cname: z.array(z.string()).optional(),
	ownership_txt: z.string().optional(),
	resolved_addresses: z.array(z.string()).optional(),
	soa: z.string().optional(),
});

export const dnsRequirementsSchema = z.object({
	a: z.array(z.string()).optional(),
	aaaa: z.array(z.string()).optional(),
	acme_challenge: acmeChallengeSchema.optional(),
	cname: z.string().optional(),
	ownership: ownershipVerificationSchema.optional(),
});

export const certificateValidationSchema = z.object({
	alpn_configured: z.boolean().optional(),
	dns_configured: z.boolean().optional(),
	http_configured: z.boolean().optional(),
	ownership_txt_configured: z.boolean().optional(),
});

export const certificateValidationErrorSchema = z.object({
	code: z.string().optional(),
	message: z.string().optional(),
	remediation: z.string().optional(),
	timestamp: z.string().optional(),
});

export const issuedCertificateSchema = z.object({
	certificate_authority: z.string().optional(),
	expires_at: z.string().optional(),
	type: z.enum(['rsa', 'ecdsa']).optional(),
});

export const certificateEntrySchema = z.object({
	created_at: z.string().optional(),
	expires_at: z.string().optional(),
	issued: z.array(issuedCertificateSchema).optional(),
	issuer: z.string().optional(),
	source: z.enum(['custom', 'fly']).optional(),
	status: z.enum(['active', 'pending_ownership', 'pending_validation']).optional(),
});
export type CertificateEntry = z.infer<typeof certificateEntrySchema>;

const certDetailBase = {
	acme_requested: z.boolean().optional(),
	certificates: z.array(certificateEntrySchema).optional(),
	configured: z.boolean().optional(),
	dns_provider: z.string().optional(),
	dns_requirements: dnsRequirementsSchema.optional(),
	hostname: z.string().optional(),
	rate_limited_until: z.string().optional(),
	status: z.string().optional(),
	validation: certificateValidationSchema.optional(),
	validation_errors: z.array(certificateValidationErrorSchema).optional(),
};

export const certificateDetailSchema = z.object(certDetailBase);
export type CertificateDetail = z.infer<typeof certificateDetailSchema>;

export const certificateCheckResponseSchema = z.object({
	...certDetailBase,
	dns_records: dnsRecordsSchema.optional(),
});
export type CertificateCheckResponse = z.infer<typeof certificateCheckResponseSchema>;

export const destroyCustomCertificateResponseSchema = z.object({
	...certDetailBase,
	warning: z.string().optional(),
});
export type DestroyCustomCertificateResponse = z.infer<typeof destroyCustomCertificateResponseSchema>;

export const certificateSummarySchema = z.object({
	acme_alpn_configured: z.boolean().optional(),
	acme_dns_configured: z.boolean().optional(),
	acme_http_configured: z.boolean().optional(),
	acme_requested: z.boolean().optional(),
	configured: z.boolean().optional(),
	created_at: z.string().optional(),
	dns_provider: z.string().optional(),
	has_custom_certificate: z.boolean().optional(),
	has_fly_certificate: z.boolean().optional(),
	hostname: z.string().optional(),
	ownership_txt_configured: z.boolean().optional(),
	status: z.string().optional(),
	updated_at: z.string().optional(),
});
export type CertificateSummary = z.infer<typeof certificateSummarySchema>;

export const listCertificatesResponseSchema = z.object({
	certificates: z.array(certificateSummarySchema).optional(),
	next_cursor: z.string().optional(),
	total_count: z.number().int().optional(),
});
export type ListCertificatesResponse = z.infer<typeof listCertificatesResponseSchema>;

export const createAcmeCertificateRequestSchema = z.object({
	hostname: z.string().optional(),
});

export const createCustomCertificateRequestSchema = z.object({
	fullchain: z.string().optional(),
	hostname: z.string().optional(),
	private_key: z.string().optional(),
});

// ----- Secrets / SecretKeys -----------------------------------------------

export const appSecretSchema = z.object({
	created_at: z.string().optional(),
	digest: z.string().optional(),
	name: z.string().optional(),
	updated_at: z.string().optional(),
	value: z.string().optional(),
});
export type AppSecret = z.infer<typeof appSecretSchema>;

export const appSecretsSchema = z.object({
	secrets: z.array(appSecretSchema).optional(),
});

export const appSecretsUpdateRequestSchema = z.object({
	values: z.record(z.string(), z.string()).optional(),
});

export const appSecretsUpdateRespSchema = z.object({
	secrets: z.array(appSecretSchema).optional(),
	Version: z.number().int().optional(),
	version: z.number().int().optional(),
});
export type AppSecretsUpdateResp = z.infer<typeof appSecretsUpdateRespSchema>;

export const setAppSecretRequestSchema = z.object({
	value: z.string().optional(),
});

export const setAppSecretResponseSchema = z.object({
	created_at: z.string().optional(),
	digest: z.string().optional(),
	name: z.string().optional(),
	updated_at: z.string().optional(),
	Version: z.number().int().optional(),
	value: z.string().optional(),
	version: z.number().int().optional(),
});
export type SetAppSecretResponse = z.infer<typeof setAppSecretResponseSchema>;

export const deleteAppSecretResponseSchema = z.object({
	Version: z.number().int().optional(),
	version: z.number().int().optional(),
});
export type DeleteAppSecretResponse = z.infer<typeof deleteAppSecretResponseSchema>;

export const secretKeySchema = z.object({
	created_at: z.string().optional(),
	name: z.string().optional(),
	public_key: z.array(z.number().int()).optional(),
	type: z.string().optional(),
	updated_at: z.string().optional(),
});
export type SecretKey = z.infer<typeof secretKeySchema>;

export const secretKeysSchema = z.object({
	secret_keys: z.array(secretKeySchema).optional(),
});

export const setSecretkeyRequestSchema = z.object({
	type: z.string().optional(),
	value: z.array(z.number().int()).optional(),
});

export const setSecretkeyResponseSchema = z.object({
	created_at: z.string().optional(),
	name: z.string().optional(),
	public_key: z.array(z.number().int()).optional(),
	type: z.string().optional(),
	updated_at: z.string().optional(),
	Version: z.number().int().optional(),
	version: z.number().int().optional(),
});
export type SetSecretkeyResponse = z.infer<typeof setSecretkeyResponseSchema>;

export const deleteSecretkeyResponseSchema = z.object({
	Version: z.number().int().optional(),
	version: z.number().int().optional(),
});
export type DeleteSecretkeyResponse = z.infer<typeof deleteSecretkeyResponseSchema>;

export const decryptSecretkeyRequestSchema = z.object({
	associated_data: z.array(z.number().int()).optional(),
	ciphertext: z.array(z.number().int()).optional(),
});

export const decryptSecretkeyResponseSchema = z.object({
	plaintext: z.array(z.number().int()).optional(),
});
export type DecryptSecretkeyResponse = z.infer<typeof decryptSecretkeyResponseSchema>;

export const encryptSecretkeyRequestSchema = z.object({
	associated_data: z.array(z.number().int()).optional(),
	plaintext: z.array(z.number().int()).optional(),
});

export const encryptSecretkeyResponseSchema = z.object({
	ciphertext: z.array(z.number().int()).optional(),
});
export type EncryptSecretkeyResponse = z.infer<typeof encryptSecretkeyResponseSchema>;

export const signSecretkeyRequestSchema = z.object({
	plaintext: z.array(z.number().int()).optional(),
});

export const signSecretkeyResponseSchema = z.object({
	signature: z.array(z.number().int()).optional(),
});
export type SignSecretkeyResponse = z.infer<typeof signSecretkeyResponseSchema>;

export const verifySecretkeyRequestSchema = z.object({
	plaintext: z.array(z.number().int()).optional(),
	signature: z.array(z.number().int()).optional(),
});

// ----- Platform / Region --------------------------------------------------

export const regionRowSchema = z.object({
	code: z.string().optional(),
	deprecated: z.boolean().optional(),
	gateway_available: z.boolean().optional(),
	geo_region: z.string().optional(),
	latitude: z.number().optional(),
	longitude: z.number().optional(),
	name: z.string().optional(),
	requires_paid_plan: z.boolean().optional(),
});
export type RegionRow = z.infer<typeof regionRowSchema>;

export const regionResponseSchema = z.object({
	nearest: z.string().optional(),
	regions: z.array(regionRowSchema).optional(),
});
export type RegionResponse = z.infer<typeof regionResponseSchema>;

export const regionPlacementSchema = z.object({
	concurrency: z.number().int().optional(),
	count: z.number().int().optional(),
	region: z.string().optional(),
});

export const getPlacementsRequestSchema = z.object({
	compute: flyMachineGuestSchema.optional(),
	count: z.number().int().optional(),
	org_slug: z.string(),
	region: z.string().optional(),
	volume_name: z.string().optional(),
	volume_size_bytes: z.number().int().optional(),
	weights: z.record(z.string(), z.number().int()).optional(),
});
export type GetPlacementsRequest = z.infer<typeof getPlacementsRequestSchema>;

export const getPlacementsResponseSchema = z.object({
	regions: z.array(regionPlacementSchema).optional(),
});
export type GetPlacementsResponse = z.infer<typeof getPlacementsResponseSchema>;

// ----- Tokens -------------------------------------------------------------

export const tokenInfoSchema = z.object({
	apps: z.array(z.string()).optional(),
	org_slug: z.string().optional(),
	organization: z.string().optional(),
	restricted_to_machine: z.string().optional(),
	source_machine_id: z.string().optional(),
	token_id: z.string().optional(),
	user: z.string().optional(),
});
export type TokenInfo = z.infer<typeof tokenInfoSchema>;

export const currentTokenResponseSchema = z.object({
	tokens: z.array(tokenInfoSchema).optional(),
});
export type CurrentTokenResponse = z.infer<typeof currentTokenResponseSchema>;

export const authenticateTokenRequestSchema = z.object({
	header: z.string().optional(),
});

export const createOIDCTokenRequestSchema = z.object({
	aud: z.string().optional(),
	aws_principal_tags: z.boolean().optional(),
});
export type CreateOIDCTokenRequest = z.infer<typeof createOIDCTokenRequestSchema>;

// resset.Action is an integer enum
export const ressetActionSchema = z.union([
	z.literal(0),
	z.literal(1),
	z.literal(2),
	z.literal(4),
	z.literal(8),
	z.literal(16),
	z.literal(31),
]);
export type RessetAction = z.infer<typeof ressetActionSchema>;

export const flyioAccessSchema = z.object({
	action: ressetActionSchema.optional(),
	app_feature: z.string().optional(),
	appid: z.number().int().optional(),
	cluster: z.string().optional(),
	command: z.array(z.string()).optional(),
	feature: z.string().optional(),
	machine: z.string().optional(),
	machine_feature: z.string().optional(),
	mutation: z.string().optional(),
	orgid: z.number().int().optional(),
	sourceApp: z.string().optional(),
	sourceMachine: z.string().optional(),
	sourceOrganization: z.string().optional(),
	storage_object: z.string().optional(),
	volume: z.string().optional(),
});

export const macaroonNonceSchema = z.object({
	kid: z.array(z.number().int()).optional(),
	proof: z.boolean().optional(),
	rnd: z.array(z.number().int()).optional(),
});

export const macaroonCaveatSetSchema = z.object({
	caveats: z.array(z.unknown()).optional(),
});

export const verifiedTokenSchema = z.object({
	caveats: macaroonCaveatSetSchema.optional(),
	header: z.string().optional(),
	nonce: macaroonNonceSchema.optional(),
	permission_token: z.array(z.number().int()).optional(),
});
export type VerifiedToken = z.infer<typeof verifiedTokenSchema>;

export const authorizeResponseSchema = z.object({
	access: flyioAccessSchema.optional(),
	verified_token: verifiedTokenSchema.optional(),
});
export type AuthorizeResponse = z.infer<typeof authorizeResponseSchema>;

export const tokenAccessSchema = z.object({
	action: ressetActionSchema.optional(),
	app_feature: z.string().optional(),
	app_name: z.string().optional(),
	command: z.array(z.string()).optional(),
	machine_feature: z.string().optional(),
	machine_id: z.string().optional(),
	mutation: z.string().optional(),
	org_feature: z.string().optional(),
	org_slug: z.string().optional(),
	source_machine: z.string().optional(),
	storage_object: z.string().optional(),
	volume_id: z.string().optional(),
});

export const authorizeTokenRequestSchema = z.object({
	access: tokenAccessSchema.optional(),
	header: z.string().optional(),
});

// ----- ErrorResponse ------------------------------------------------------

export const errorResponseSchema = z.object({
	details: z.unknown().optional(),
	error: z.string().optional(),
	status: z.enum(['unknown', 'insufficient_capacity']).optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
