<script lang="ts">
	import { t } from '$lib/i18n/translation';
	import { Plus, Trash2 } from '@lucide/svelte';
	import maplibregl from 'maplibre-gl';
	import Button from '$lib/components/ui/button/button.svelte';
	import {
		type PedestrianSpeed,
		type CyclingSpeed,
		type ElevationCosts,
		type PedestrianProfile,
		type ServerConfig
	} from '@motis-project/motis-client';
	import type { IsochronesOptions } from '$lib/map/IsochronesShared';
	import { ORIGIN_COLORS } from '$lib/map/NToAllColors';
	import AddressTypeahead from '$lib/AddressTypeahead.svelte';
	import AdvancedOptions from '$lib/AdvancedOptions.svelte';
	import DateInput from '$lib/DateInput.svelte';
	import { type Location } from '$lib/Location';
	import { formatDurationSec } from '$lib/formatDuration';
	import type { PrePostDirectMode, TransitMode } from '$lib/Modes';
	import { generateTimes } from './generateTimes';
	import Slider from './components/ui/slider/Slider.svelte';
	import IsochronesInfo from '$lib/IsochronesInfo.svelte';

	let {
		advancedOptionsOpen = $bindable(),
		origins = $bindable(),
		maxTravelTime = $bindable(),
		serverConfig,
		geocodingBiasPlace,
		time = $bindable(),
		useRoutedTransfers = $bindable(),
		pedestrianProfile = $bindable(),
		requireBikeTransport = $bindable(),
		requireCarTransport = $bindable(),
		noCompulsoryReservation = $bindable(),
		transitModes = $bindable(),
		maxTransfers = $bindable(),
		preTransitModes = $bindable(),
		postTransitModes = $bindable(),
		additionalTransferTime = $bindable(),
		transferTimeFactor = $bindable(),
		cyclingSpeed = $bindable(),
		pedestrianSpeed = $bindable(),
		maxPreTransitTime = $bindable(),
		maxPostTransitTime = $bindable(),
		elevationCosts = $bindable(),
		ignorePreTransitRentalReturnConstraints = $bindable(),
		ignorePostTransitRentalReturnConstraints = $bindable(),
		options = $bindable(),
		preTransitProviderGroups = $bindable(),
		postTransitProviderGroups = $bindable(),
		directProviderGroups = $bindable(),
		vehicleHeight = $bindable(),
		vehicleWidth = $bindable(),
		vehicleLength = $bindable(),
		vehicleWeight = $bindable(),
		vehicleHazmat = $bindable(),
		vehicleHazmatWater = $bindable(),
		vehicleAxleCount = $bindable(),
		vehicleAxleLoad = $bindable(),
		vehicleTrailer = $bindable(),
		vehicleTopSpeed = $bindable(),
		vehicleLezAccess = $bindable(),
		hasDebug = false
	}: {
		advancedOptionsOpen: boolean;
		origins: Location[];
		maxTravelTime: number;
		serverConfig: ServerConfig | undefined;
		geocodingBiasPlace?: maplibregl.LngLatLike;
		time: Date;
		useRoutedTransfers: boolean;
		pedestrianProfile: PedestrianProfile;
		requireBikeTransport: boolean;
		requireCarTransport: boolean;
		noCompulsoryReservation: boolean;
		transitModes: TransitMode[];
		maxTransfers: number;
		preTransitModes: PrePostDirectMode[];
		postTransitModes: PrePostDirectMode[];
		additionalTransferTime: number | undefined;
		transferTimeFactor: number;
		cyclingSpeed: CyclingSpeed;
		pedestrianSpeed: PedestrianSpeed;
		maxPreTransitTime: number;
		maxPostTransitTime: number;
		elevationCosts: ElevationCosts;
		ignorePreTransitRentalReturnConstraints: boolean;
		ignorePostTransitRentalReturnConstraints: boolean;
		options: IsochronesOptions;
		preTransitProviderGroups: string[];
		postTransitProviderGroups: string[];
		directProviderGroups: string[];
		vehicleHeight: number;
		vehicleWidth: number;
		vehicleLength: number;
		vehicleWeight: number;
		vehicleHazmat: boolean;
		vehicleHazmatWater: boolean;
		vehicleAxleCount: number;
		vehicleAxleLoad: number;
		vehicleTrailer: boolean;
		vehicleTopSpeed: number;
		vehicleLezAccess: boolean;
		hasDebug: boolean;
	} = $props();

	const minutesToSeconds = (n: number): number => n * 60;
	const possibleMaxTravelTimes = $derived(
		generateTimes(
			minutesToSeconds(Math.min(serverConfig?.maxOneToAllTravelTimeLimit ?? 4 * 60, 6 * 60))
		).map((s) => ({
			value: s.toString(),
			label: formatDurationSec(s)
		}))
	);


	const addOrigin = () => {
		if (origins.length >= 8) return;
		origins = [...origins, {} as Location];
	};

	const removeOrigin = (i: number) => {
		if (origins.length <= 2) return;
		origins = origins.filter((_, idx) => idx !== i);
	};
</script>

{#snippet additionalComponents()}
	<div class="grid grid-cols-2 items-center text-sm gap-2">
		<span>{t.isochronesOpacity}</span>
		<Slider min={0} max={1000} bind:value={options.opacity} />
	</div>
{/snippet}

<div
	id="n-to-all-searchmask-container"
	class="flex max-h-full min-h-0 flex-col space-y-4 overflow-y-auto p-4"
>
	<!-- One typeahead per origin with colour swatch and remove button -->
	<div class="flex flex-col gap-2">
		{#each origins as _, i}
			<div class="flex items-center gap-2">
				<span
					class="inline-block h-3 w-3 shrink-0 rounded-full"
					style="background: {ORIGIN_COLORS[i % ORIGIN_COLORS.length]}"
				></span>
				<div class="grow">
					<AddressTypeahead
						place={geocodingBiasPlace}
						name="n-to-all-origin-{i}"
						placeholder="Origin {i + 1}"
						selected={origins[i]}
						onChange={(loc) => {
							const updated = [...origins];
							updated[i] = loc;
							origins = updated;
						}}
					/>
				</div>
				{#if origins.length > 2}
					<Button
						variant="ghost"
						size="icon"
						class="shrink-0"
						onclick={() => removeOrigin(i)}
						title="Remove origin"
					>
						<Trash2 class="h-4 w-4" />
					</Button>
				{/if}
			</div>
		{/each}
		{#if origins.length < 8}
			<Button
				variant="outline"
				size="sm"
				class="w-full gap-2"
				onclick={addOrigin}
			>
				<Plus class="h-4 w-4" />
				Add origin
			</Button>
		{/if}
	</div>

	<!-- Time + advanced options — same as IsochronesMask but no arriveBy -->
	<div class="flex min-h-0 flex-row gap-2 flex-wrap">
		<DateInput bind:value={time} />
		<AdvancedOptions
			bind:advancedOptionsOpen
			bind:useRoutedTransfers
			{serverConfig}
			bind:wheelchair={
				() => pedestrianProfile === 'WHEELCHAIR',
				(v) => (pedestrianProfile = v ? 'WHEELCHAIR' : 'FOOT')
			}
			bind:requireCarTransport
			bind:requireBikeTransport
			bind:noCompulsoryReservation
			bind:transitModes
			bind:maxTransfers
			bind:maxTravelTime
			bind:additionalTransferTime
			bind:cyclingSpeed
			bind:pedestrianProfile
			bind:pedestrianSpeed
			bind:transferTimeFactor
			{possibleMaxTravelTimes}
			bind:preTransitModes
			bind:postTransitModes
			directModes={undefined}
			bind:maxPreTransitTime
			bind:maxPostTransitTime
			maxDirectTime={undefined}
			bind:elevationCosts
			bind:ignorePreTransitRentalReturnConstraints
			bind:ignorePostTransitRentalReturnConstraints
			ignoreDirectRentalReturnConstraints={undefined}
			{additionalComponents}
			bind:preTransitProviderGroups
			bind:postTransitProviderGroups
			bind:directProviderGroups
			bind:vehicleHeight
			bind:vehicleWidth
			bind:vehicleLength
			bind:vehicleWeight
			bind:vehicleHazmat
			bind:vehicleHazmatWater
			bind:vehicleAxleCount
			bind:vehicleAxleLoad
			bind:vehicleTrailer
			bind:vehicleTopSpeed
			bind:vehicleLezAccess
			via={undefined}
			viaMinimumStay={undefined}
			viaLabels={{}}
			{hasDebug}
		/>
	</div>

	<!-- Status: loading / empty / error -->
	<IsochronesInfo {options} />

	<!-- Legend: colour gradient per origin -->
	<div class="flex flex-col gap-1 text-xs text-muted-foreground">
		{#each origins as origin, i}
			{#if origin?.label}
				<div class="flex items-center gap-2">
					<span
						class="border-border h-2 w-16 shrink-0 rounded-full border"
						style="background: linear-gradient(to right,
							{ORIGIN_COLORS[i % ORIGIN_COLORS.length]}22,
							{ORIGIN_COLORS[i % ORIGIN_COLORS.length]})"
					></span>
					<span class="truncate">{origin.label}</span>
					<span class="ml-auto shrink-0">0 – {formatDurationSec(maxTravelTime)}</span>
				</div>
			{/if}
		{/each}
	</div>
</div>
