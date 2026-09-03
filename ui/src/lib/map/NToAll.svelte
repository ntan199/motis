<script lang="ts">
	import { untrack } from 'svelte';
	import type { Map } from 'maplibre-gl';
	import type { PrePostDirectMode } from '$lib/Modes';
	import type { IsochronesOptions } from '$lib/map/IsochronesShared';
	import type { ReachablePlace } from '@motis-project/motis-client';
	import { NToAllLayer, NToAllBestLayer } from '$lib/map/NToAllLayer';
	import type { IsochronesCircle } from '$lib/map/IsochronesLayer';

	export const ORIGIN_COLORS = [
		'#E6194B',
		'#3CB44B',
		'#4363D8',
		'#F58231',
		'#911EB4',
		'#42D4F4',
		'#F032E6',
		'#BFEF45'
	];

	let {
		map,
		origins,
		streetModes,
		wheelchair,
		maxAllTime,
		maxTravelTime,
		active,
		options
	}: {
		map: Map | undefined;
		origins: { id: string; name: string }[];
		streetModes: PrePostDirectMode[];
		wheelchair: boolean;
		maxAllTime: number;
		maxTravelTime: number;
		active: boolean;
		options: IsochronesOptions;
	} = $props();

	const metersPerSecond = $derived(
		streetModes.includes('BIKE') ? 3.8 : wheelchair ? 0.8 : 1.2
	);

	// Plain variables — never reactive.
	let currentLayers: NToAllLayer[] = [];
	let bestLayer: NToAllBestLayer | null = null;

	$effect(() => {
		if (!map) return;
		const m = map;

		const currentOrigins = origins;
		const opacity = options.opacity / 1000;
		const isActive = active;

		// Remove old layers.
		untrack(() => {
			for (const layer of currentLayers) {
				if (m.getLayer(layer.id)) m.removeLayer(layer.id);
			}
			if (bestLayer && m.getLayer(bestLayer.id)) m.removeLayer(bestLayer.id);
		});

		// Create one NToAllLayer per origin + one NToAllBestLayer shared.
		const newLayers = currentOrigins.map((_, i) =>
			new NToAllLayer(`n-to-all-${i}`, ORIGIN_COLORS[i % ORIGIN_COLORS.length])
		);
		const newBest = new NToAllBestLayer();
		newBest.setLayers(newLayers);

		untrack(() => {
			currentLayers = newLayers;
			bestLayer = newBest;
		});

		const addLayers = () => {
			if (!m.isStyleLoaded()) return;
			// Add origin layers first so their prerender() runs before best.
			for (const layer of newLayers) {
				if (!m.getLayer(layer.id)) {
					try { m.addLayer(layer); }
					catch (e) { console.error('[NToAll] addLayer failed', e); }
				}
				layer.setOpacity(opacity);
				layer.setActive(isActive);
			}
			// Best layer runs AFTER — its prerender() MAX-blends all union textures.
			if (!m.getLayer(newBest.id)) {
				try { m.addLayer(newBest); }
				catch (e) { console.error('[NToAll] addBestLayer failed', e); }
			}
		};

		addLayers();
		m.on('styledata', addLayers);
		m.on('idle', addLayers);

		return () => {
			m.off('styledata', addLayers);
			m.off('idle', addLayers);
			untrack(() => {
				for (const layer of currentLayers) {
					if (m.getLayer(layer.id)) m.removeLayer(layer.id);
				}
				if (bestLayer && m.getLayer(bestLayer.id)) m.removeLayer(bestLayer.id);
				currentLayers = [];
				bestLayer = null;
			});
		};
	});

	export function setResults(places: ReachablePlace[]) {
		const groups: IsochronesCircle[][] = origins.map(() => []);

		for (const p of places) {
			const i = p.originIndex;
			if (i == null || i < 0 || i >= origins.length) continue;
			if (!p.place?.lat || !p.place?.lon) continue;

			// Full walking radius circle — same as Isochrones.svelte.
			// The Voronoi clipping in the GPU shader prevents overlap:
			// each pixel is only rendered by the fastest origin.
			const centerSeconds = Math.max(0, maxTravelTime - 60 * (p.duration ?? 0));
			const walkSeconds = Math.min(centerSeconds, maxAllTime);

			groups[i].push({
				lng: p.place.lon,
				lat: p.place.lat,
				radiusMeters: walkSeconds * metersPerSecond,
				centerSeconds,
				edgeSeconds: centerSeconds - walkSeconds
			});
		}

		for (let i = 0; i < currentLayers.length; i++) {
			currentLayers[i].setCircles(groups[i] ?? [], maxTravelTime);
		}

		map?.triggerRepaint();
	}
</script>

{#if active && origins.length > 0}
	<div
		class="absolute bottom-8 right-4 z-10 flex flex-col gap-1
		       rounded-lg bg-background/90 px-3 py-2 shadow text-sm"
	>
		{#each origins as origin, i}
			<div class="flex items-center gap-2">
				<span
					class="inline-block h-3 w-3 rounded-full"
					style="background: {ORIGIN_COLORS[i % ORIGIN_COLORS.length]}"
				></span>
				<span>{origin.name}</span>
			</div>
		{/each}
	</div>
{/if}
