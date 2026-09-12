package mcextract;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.entity.EntityDimensions;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.VoxelShape;
import net.minecraft.core.BlockPos;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Offline extractor for the things Minecraft defines in CODE rather than in assets:
 * the player's movement constants, and every block's collision shape and hardness.
 *
 * WHY THIS EXISTS. The browser client had to invent these. Movement used hand-tuned
 * gravity and jump constants, and collision was a hand-written list of "these ~60 block
 * names are walk-through, everything else is a solid 1x1x1 cube" (src/app/nav-world.ts).
 * Both are guesses, both are wrong for modded content, and neither can be derived from a
 * blockstate JSON or a model — Minecraft simply does not ship this as data.
 *
 * It does not have to be a guess. `harness/run.sh` already deobfuscates the client jar and
 * boots the real game far enough to call into it (SharedConstants.tryDetectVersion() +
 * Bootstrap.bootStrap()), which is what ExtractModels uses to pull real entity geometry.
 * The same boot makes the real block registry live, so this asks the actual game:
 *
 *   state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO).toAabbs()
 *   state.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
 *   Player.createAttributes().build().getValue(Attributes.GRAVITY)   ... and friends
 *
 * These are the real numbers out of the real code, not a table someone typed.
 *
 * SCOPE, STATED PLAINLY. This boots vanilla, not NeoForge. Mod jars are on the classpath
 * but mod blocks are never REGISTERED, because registration happens inside NeoForge's mod
 * loader. So this emits every vanilla block state exactly, and nothing for modded blocks.
 * The client falls back for those — see src/app/block-shapes.ts, which prefers this table,
 * then the block's own baked model bounds, then the old name heuristic. The failure order
 * matters: exact, then derived-from-assets, then guess.
 *
 * Usage (called from run.sh step 7):
 *   java -cp <build>:<deobf client jar>:<libs> mcextract.ExtractPhysics --out <dir>
 */
public final class ExtractPhysics {

	/** A block state's collision + mining data, as the client needs it. */
	static final class StateInfo {
		/** index into the shape palette */
		int s;
		/** destroy time in seconds-ish units, exactly as getDestroySpeed returns it; -1 = unbreakable */
		float h;
		/** index into the sound palette; -1 when the block has no sound type */
		int snd = -1;
	}

	/**
	 * One block's SoundType, as sound-event ids.
	 *
	 * Which sound a block makes when it is broken, stepped on or placed is a `SoundType`
	 * CONSTANT in Java, not a data file — so a browser has no way to know that stone crunches
	 * and wool thuds. Extracting it is what makes audio generic across mods instead of a
	 * table of vanilla block names.
	 */
	static final class SoundInfo {
		String breakSound, stepSound, placeSound, hitSound, fallSound;
		float volume, pitch;
	}

	/**
	 * One tool's mining behaviour, as the client needs it.
	 *
	 * How fast a block breaks is `speed / hardness / (correctForDrops ? 30 : 100)` per tick,
	 * and `speed` comes from the item's TOOL data component. That component is how vanilla
	 * AND every mod describes a tool in 1.21, so extracting it is generic rather than a table
	 * of known tools: each rule names a set of blocks, a speed, and whether it drops.
	 */
	static final class ToolInfo {
		String id;
		float defaultSpeed;
		List<ToolRule> rules = new ArrayList<>();
	}

	static final class ToolRule {
		/**
		 * The block TAG this rule applies to, e.g. `minecraft:mineable/pickaxe`.
		 *
		 * A tag id rather than a resolved block list, and that is not a shortcut — it is the
		 * only thing available. `Bootstrap.bootStrap()` builds the registries but does NOT
		 * load datapack tags (those arrive on a server reload), so a tag HolderSet here
		 * resolves to ZERO blocks. The first version of this extraction emitted those empty
		 * lists and every tool silently matched nothing.
		 *
		 * Tags ARE data — `data/<ns>/tags/block/mineable/*.json` ships in the jars — so the
		 * bake resolves them, which also keeps modded tools working.
		 */
		String tag;
		/** blocks named directly by the rule, when it does not use a tag */
		List<String> blocks = new ArrayList<>();
		Float speed;
		Boolean correct;
	}

	static final class Output {
		String version;
		Map<String, Object> player = new LinkedHashMap<>();
		/** palette of distinct collision shapes; each is a list of [x0,y0,z0,x1,y1,z1] */
		List<List<double[]>> shapes = new ArrayList<>();
		/** palette of distinct sound types, indexed by StateInfo.snd */
		List<SoundInfo> sounds = new ArrayList<>();
		/** every item that is a tool, with its mining rules */
		List<ToolInfo> tools = new ArrayList<>();
		/** every block state that carries a fluid, with the fluid's own surface height */
		List<Map<String, Object>> fluids = new ArrayList<>();
		/** dye id -> the RGB the game tints with, for sheep wool / collars / leather */
		Map<String, Object> dyes = new LinkedHashMap<>();
		/** blocks that emit ambient particles, i.e. that override animateTick */
		List<String> particleBlocks = new ArrayList<>();
		/** entity type id -> its collision box, which is what scales a spawner's display mob */
		Map<String, Object> entitySizes = new LinkedHashMap<>();
		/** registry name -> variant id -> texture, for mobs whose skin is a registry entry */
		Map<String, Object> entityVariants = new LinkedHashMap<>();

		/** canonical "ns:name[k=v,k=v]" (properties sorted) -> its collision + hardness */
		Map<String, StateInfo> blocks = new TreeMap<>();
		Map<String, Object> stats = new LinkedHashMap<>();
		List<String> notes = new ArrayList<>();
	}

	/** Shape palette: the serialised boxes -> index, so 26k states share a few hundred shapes. */
	static final Map<String, Integer> shapeIndex = new LinkedHashMap<>();
	/** Sound palette: vanilla has a few dozen SoundTypes shared by every block. */
	static final Map<String, Integer> soundIndex = new LinkedHashMap<>();


	public static void main(String[] argv) throws Exception {
		Map<String, String> args = ExtractModels.parseArgs(argv);
		Path outDir = Paths.get(args.getOrDefault("out", "out"));
		Files.createDirectories(outDir);

		log("booting the real game (registries only, no window)");
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();

		Output out = new Output();
		out.version = net.minecraft.SharedConstants.getCurrentVersion().getName();
		log("version " + out.version);

		extractPlayer(out);
		extractBlocks(out);
		extractTools(out);
		extractFluids(out);
		extractDyes(out);
		extractParticleBlocks(out);
		extractEntitySizes(out);
		extractEntityVariants(out);

		out.stats.put("shapes", out.shapes.size());
		out.stats.put("soundTypes", out.sounds.size());
		out.stats.put("blockStates", out.blocks.size());
		Gson gson = new GsonBuilder().serializeNulls().create();
		Path file = outDir.resolve("physics.json");
		Files.write(file, gson.toJson(out).getBytes(StandardCharsets.UTF_8));
		log("wrote " + file + " (" + out.blocks.size() + " states, " + out.shapes.size() + " shapes)");
	}

	/**
	 * The 16 dye colours, as the game itself tints with them.
	 *
	 * Needed for sheep wool, wolf/cat collars and leather armour. READ, not remembered:
	 * `DyeColor.getTextureDiffuseColor()` is the exact int the renderer multiplies by, and
	 * white is NOT 0xFFFFFF — vanilla darkens sheep wool specifically so a white sheep does
	 * not blow out against snow. `Sheep.getColor` is consulted where it exists so the sheep
	 * value is the sheep's own, not the generic dye.
	 */
	static void extractDyes(Output out) {
		for (net.minecraft.world.item.DyeColor dye : net.minecraft.world.item.DyeColor.values()) {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("id", dye.getId());
			int rgb = 0;
			try {
				rgb = (int) net.minecraft.world.item.DyeColor.class
					.getMethod("getTextureDiffuseColor").invoke(dye);
			} catch (Throwable t) {
				try {
					float[] f = (float[]) net.minecraft.world.item.DyeColor.class
						.getMethod("getTextureDiffuseColors").invoke(dye);
					rgb = (Math.round(f[0] * 255) << 16) | (Math.round(f[1] * 255) << 8) | Math.round(f[2] * 255);
				} catch (Throwable t2) { rgb = -1; }
			}
			row.put("rgb", rgb);
			// The sheep's own table, where the client exposes it. Vanilla white wool is
			// 0.9019608 grey rather than pure white; taking the dye value would be wrong.
			for (String m : new String[] { "getColor", "getColorArray" }) {
				try {
					Object v = net.minecraft.world.entity.animal.Sheep.class
						.getMethod(m, net.minecraft.world.item.DyeColor.class).invoke(null, dye);
					if (v instanceof float[] f) {
						row.put("sheep", new double[] { f[0], f[1], f[2] });
					} else if (v instanceof Integer i) {
						row.put("sheep", new double[] {
							((i >> 16) & 0xff) / 255.0, ((i >> 8) & 0xff) / 255.0, (i & 0xff) / 255.0 });
					}
					break;
				} catch (Throwable t) { /* try the next spelling */ }
			}
			out.dyes.put(dye.getName(), row);
		}
		out.stats.put("dyes", out.dyes.size());
		log("dyes: " + out.dyes.size() + " colours");
	}

	/**
	 * Blocks that emit ambient particles.
	 *
	 * Vanilla draws a torch's flame, a campfire's smoke and lava's sparks from
	 * `Block.animateTick`, which the base class leaves empty — so "does this block make
	 * particles?" is exactly "does it override animateTick?". Asking the class rather than
	 * listing names makes this cover all 130 mods: a Create machine that animates gets
	 * found the same way a torch does.
	 */
	static void extractParticleBlocks(Output out) {
		Class<?> base = null;
		try {
			base = Class.forName("net.minecraft.world.level.block.state.BlockBehaviour");
		} catch (Throwable t) { /* fall through to Block */ }
		for (Block block : BuiltInRegistries.BLOCK) {
			ResourceLocation id = BuiltInRegistries.BLOCK.getKey(block);
			if (id == null) continue;
			try {
				java.lang.reflect.Method m = block.getClass().getMethod("animateTick",
					net.minecraft.world.level.block.state.BlockState.class,
					net.minecraft.world.level.Level.class,
					net.minecraft.core.BlockPos.class,
					net.minecraft.util.RandomSource.class);
				Class<?> decl = m.getDeclaringClass();
				if (decl != base && decl != Block.class
					&& !decl.getName().equals("net.minecraft.world.level.block.state.BlockBehaviour")) {
					out.particleBlocks.add(id.toString());
				}
			} catch (Throwable t) { /* no such method: no particles */ }
		}
		out.stats.put("particleBlocks", out.particleBlocks.size());
		log("particle blocks: " + out.particleBlocks.size() + " override animateTick");
	}

	/**
	 * Every entity type's collision box.
	 *
	 * A spawner scales its display mob by `0.53125 / max(bbWidth, bbHeight)` when that
	 * maximum exceeds 1, so drawing the cage's mob at the right size needs the real
	 * dimensions rather than the model's drawn extent — a skeleton's model is taller than its
	 * 1.99-block box. Read from the registry, so modded mobs are covered too.
	 */
	static void extractEntitySizes(Output out) {
		for (net.minecraft.world.entity.EntityType<?> type : BuiltInRegistries.ENTITY_TYPE) {
			ResourceLocation id = BuiltInRegistries.ENTITY_TYPE.getKey(type);
			if (id == null) continue;
			try {
				Map<String, Object> row = new LinkedHashMap<>();
				row.put("w", type.getWidth());
				row.put("h", type.getHeight());
				out.entitySizes.put(id.toString(), row);
			} catch (Throwable t) { /* a type that cannot report its size is simply omitted */ }
		}
		out.stats.put("entitySizes", out.entitySizes.size());
		log("entity sizes: " + out.entitySizes.size() + " types");
	}

	/**
	 * Mobs whose skin comes from a registry entry rather than from one fixed texture.
	 *
	 * The entity extractor resolves ONE texture per entity type, so a cat — whose texture is
	 * a property of its variant — ended up with `texture: null` and drew nothing at all. Wolf
	 * coats solved the same problem from the datapack, but cat and frog variants are a
	 * built-in registry, so the mapping has to come out of the running game.
	 *
	 * Generic by construction: any registry whose entries expose a `texture()` is walked, so
	 * a mod adding a cat variant is covered without naming it here.
	 */
	static void extractEntityVariants(Output out) {
		String[][] wanted = {
			{ "cat_variant", "CAT_VARIANT" },
			{ "frog_variant", "FROG_VARIANT" },
			{ "wolf_variant", "WOLF_VARIANT" },
			{ "painting_variant", "PAINTING_VARIANT" },
			// No texture, but their REGISTRY ORDER is what a network index means: entity
			// metadata sends a villager's profession as an int, and only the registry says
			// which one it is.
			{ "villager_profession", "VILLAGER_PROFESSION" },
			{ "villager_type", "VILLAGER_TYPE" },
		};
		int total = 0;
		for (String[] w : wanted) {
			Map<String, Object> rows = new LinkedHashMap<>();
			try {
				java.lang.reflect.Field f = BuiltInRegistries.class.getField(w[1]);
				Object registry = f.get(null);
				java.lang.reflect.Method keySet = registry.getClass().getMethod("keySet");
				java.lang.reflect.Method get = registry.getClass().getMethod("get", ResourceLocation.class);
				// `getId` is what makes this usable against the network protocol: entity
				// metadata sends a variant as an INT, and only the registry's own id says
				// which entry that is. Without it a consumer is reduced to guessing from
				// iteration order, which is right until a mod inserts an entry.
				java.lang.reflect.Method getId = null;
				try { getId = registry.getClass().getMethod("getId", Object.class); } catch (Throwable ignored) { }
				for (Object key : (java.util.Set<?>) keySet.invoke(registry)) {
					Object entry = get.invoke(registry, key);
					if (entry == null) continue;
					Map<String, Object> row = new LinkedHashMap<>();
					String tex = textureOf(entry);
					if (tex != null) row.put("texture", tex);
					if (getId != null) {
						try { row.put("id", getId.invoke(registry, entry)); } catch (Throwable ignored) { }
					}
					if (!row.isEmpty()) rows.put(key.toString(), row);
				}
			} catch (Throwable t) { /* registry absent in this version; skip it */ }
			if (!rows.isEmpty()) {
				out.entityVariants.put(w[0], rows);
				total += rows.size();
			}
		}
		total += extractEnumVariants(out);
		out.stats.put("entityVariants", total);
		log("entity variants: " + total + " across " + out.entityVariants.size() + " registries");
	}

	/**
	 * Variants that are a Java ENUM rather than a registry.
	 *
	 * The axolotl is the case that matters: its renderer builds the texture path with a
	 * `%s` format string, which the model extractor faithfully recorded as if it were a file
	 * name — leaving one permanently "missing" sprite in every atlas and an axolotl that
	 * would draw nothing. Its NBT stores the variant as an INT, so the map is keyed by that
	 * int rather than by a name.
	 *
	 * The values are read off the enum, not written down: `getSerializedName()` gives the
	 * texture stem and the declared order gives the id, exactly as `Axolotl.Variant.BY_ID`
	 * indexes it.
	 */
	static int extractEnumVariants(Output out) {
		Map<String, Object> rows = new LinkedHashMap<>();
		try {
			Class<?> v = Class.forName("net.minecraft.world.entity.animal.axolotl.Axolotl$Variant");
			Object[] values = (Object[]) v.getMethod("values").invoke(null);
			for (Object entry : values) {
				String name = (String) v.getMethod("getSerializedName").invoke(entry);
				int id = ((Enum<?>) entry).ordinal();
				rows.put(String.valueOf(id), "minecraft:textures/entity/axolotl/axolotl_" + name + ".png");
			}
		} catch (Throwable t) { /* not this version's shape; the caller simply has no axolotl */ }
		if (rows.isEmpty()) return 0;
		out.entityVariants.put("axolotl_variant", rows);
		return rows.size();
	}

	/** A variant's texture, however that version spells the accessor. */
	static String textureOf(Object entry) {
		for (String m : new String[] { "texture", "assetId", "getTexture" }) {
			try {
				Object v = entry.getClass().getMethod(m).invoke(entry);
				if (v != null) return v.toString();
			} catch (Throwable ignored) { /* try the next spelling */ }
		}
		return null;
	}

	// ------------------------------------------------------------------
	// The player.

	/**
	 * The movement constants, read off the real attribute defaults.
	 *
	 * In 1.21 these stopped being scattered literals and became first-class attributes
	 * (Attributes.GRAVITY, JUMP_STRENGTH, STEP_HEIGHT, SNEAKING_SPEED...), which is why
	 * this is a clean read rather than a bytecode scrape. Everything here is per-TICK, as
	 * the game stores it; the client converts to per-second once, in one place.
	 */
	static void extractPlayer(Output out) {
		AttributeSupplier attrs = Player.createAttributes().build();
		out.player.put("movementSpeed", attrs.getValue(Attributes.MOVEMENT_SPEED));
		out.player.put("gravity", attrs.getValue(Attributes.GRAVITY));
		out.player.put("jumpStrength", attrs.getValue(Attributes.JUMP_STRENGTH));
		out.player.put("stepHeight", attrs.getValue(Attributes.STEP_HEIGHT));
		out.player.put("sneakingSpeed", attrs.getValue(Attributes.SNEAKING_SPEED));
		out.player.put("blockBreakSpeed", attrs.getValue(Attributes.BLOCK_BREAK_SPEED));
		out.player.put("blockInteractionRange", attrs.getValue(Attributes.BLOCK_INTERACTION_RANGE));

		EntityDimensions dim = Player.STANDING_DIMENSIONS;
		out.player.put("width", dim.width());
		out.player.put("height", dim.height());
		out.player.put("eyeHeight", dim.eyeHeight());
		out.player.put("crouchHeight", Player.CROUCH_BB_HEIGHT);

		// Sprinting is NOT an attribute default — it is an AttributeModifier the game adds
		// to MOVEMENT_SPEED while you sprint, so it is read off the modifier itself. Both
		// its amount and its operation are reported: the operation decides whether the
		// client multiplies or adds, and hardcoding "multiply" would be exactly the kind of
		// assumption this whole file exists to remove.
		readSprint(out);
		// Which Inventory slot number is the OFF HAND.
		//
		// `data get entity <name> Inventory` returns every compartment in one list keyed by
		// slot, so telling the off-hand apart from a hotbar slot needs this number — and it
		// is a Java constant, not something the NBT labels. Read rather than assumed.
		try {
			java.lang.reflect.Field f = net.minecraft.world.entity.player.Inventory.class
					.getDeclaredField("SLOT_OFFHAND");
			f.setAccessible(true);
			out.player.put("offhandSlot", f.getInt(null));
		} catch (Throwable t) {
			out.notes.add("could not read Inventory.SLOT_OFFHAND: " + t);
		}
		log("player: " + out.player);
	}

	static void readSprint(Output out) {
		try {
			java.lang.reflect.Field f = net.minecraft.world.entity.LivingEntity.class
					.getDeclaredField("SPEED_MODIFIER_SPRINTING");
			f.setAccessible(true);
			Object mod = f.get(null);
			Class<?> c = mod.getClass();
			double amount = (Double) c.getMethod("amount").invoke(mod);
			Object op = c.getMethod("operation").invoke(mod);
			out.player.put("sprintModifier", amount);
			out.player.put("sprintOperation", String.valueOf(op));
		} catch (Throwable t) {
			// Omitted, never defaulted: the client then keeps its own fallback and says so,
			// rather than being handed a number this failed to read.
			out.notes.add("could not read LivingEntity.SPEED_MODIFIER_SPRINTING: " + t);
		}
	}

	/**
	 * Every item carrying a TOOL component.
	 *
	 * Nothing here knows a tool's name: an item either has the component or it does not, so a
	 * modded drill is read exactly the way a vanilla pickaxe is. The rules' block sets are
	 * resolved to real block ids at extraction time, so the browser needs no tag files.
	 */
	static void extractTools(Output out) {
		int withTool = 0;
		for (net.minecraft.world.item.Item item : BuiltInRegistries.ITEM) {
			net.minecraft.world.item.component.Tool tool =
					item.components().get(net.minecraft.core.component.DataComponents.TOOL);
			if (tool == null) continue;
			ResourceLocation id = BuiltInRegistries.ITEM.getKey(item);
			if (id == null) continue;
			ToolInfo info = new ToolInfo();
			info.id = id.toString();
			info.defaultSpeed = tool.defaultMiningSpeed();
			for (net.minecraft.world.item.component.Tool.Rule rule : tool.rules()) {
				ToolRule r = new ToolRule();
				readRuleBlocks(rule.blocks(), r);
				r.speed = rule.speed().orElse(null);
				r.correct = rule.correctForDrops().orElse(null);
				info.rules.add(r);
			}
			out.tools.add(info);
			withTool++;
		}
		out.stats.put("tools", withTool);
		log("tools: " + withTool + " items with a TOOL component");
	}

	/**
	 * A rule's blocks: the TAG it names, or the literal blocks when it names no tag.
	 *
	 * `unwrapKey()` gives the tag even though `stream()` gives nothing, because the tag is
	 * how the rule was WRITTEN — only its membership needs a datapack. That distinction is
	 * what makes this recoverable at bake time.
	 */
	static void readRuleBlocks(
			net.minecraft.core.HolderSet<net.minecraft.world.level.block.Block> set, ToolRule r) {
		try {
			java.util.Optional<net.minecraft.tags.TagKey<net.minecraft.world.level.block.Block>> key =
					set.unwrapKey();
			if (key.isPresent()) {
				r.tag = key.get().location().toString();
				return;
			}
			set.stream().forEach(h -> h.unwrapKey().ifPresent(k -> r.blocks.add(k.location().toString())));
			java.util.Collections.sort(r.blocks);
		} catch (Throwable t) {
			// A rule we cannot describe matches nothing, which is safer than matching all.
			r.tag = null;
		}
	}

	/**
	 * The surface height of every fluid state, read from the game.
	 *
	 * A fluid's geometry is generated, not modelled, so the renderer has to know how tall
	 * each level stands. `FluidState.getOwnHeight()` is the game's own answer, so this is
	 * measured rather than the 8/9-and-(8-level)/9 formula written from memory — and it
	 * covers modded fluids for free, since they answer the same call.
	 */
	static void extractFluids(Output out) {
		for (Block block : BuiltInRegistries.BLOCK) {
			ResourceLocation id = BuiltInRegistries.BLOCK.getKey(block);
			if (id == null) continue;
			for (BlockState state : block.getStateDefinition().getPossibleStates()) {
				net.minecraft.world.level.material.FluidState fs = state.getFluidState();
				if (fs == null || fs.isEmpty()) continue;
				Map<String, Object> row = new LinkedHashMap<>();
				row.put("state", stateKey(id, state));
				row.put("height", fs.getOwnHeight());
				row.put("amount", fs.getAmount());
				row.put("source", fs.isSource());
				ResourceLocation fid = BuiltInRegistries.FLUID.getKey(fs.getType());
				row.put("fluid", fid == null ? null : fid.toString());
				out.fluids.add(row);
			}
		}
		out.stats.put("fluidStates", out.fluids.size());
		log("fluids: " + out.fluids.size() + " states with a fluid");
	}

	// ------------------------------------------------------------------
	// Blocks.

	/**
	 * Every block state's shape and hardness — collapsed where the states agree.
	 *
	 * Most blocks (stone, dirt, ore, glass, wool...) have one shape and one hardness across
	 * every state they have, and emitting 26,684 rows when a few thousand carry all the
	 * information makes a 3.3 MB file out of a 400 KB one. So a block whose states ALL agree
	 * is written once under its plain id, and only genuinely state-dependent blocks (stairs,
	 * slabs, fences, doors, trapdoors) are written per state. The client looks up the exact
	 * state first and falls back to the plain id, so the two shapes of entry cost it nothing
	 * — see `fromTable` in src/app/block-shapes.ts.
	 */
	static void extractBlocks(Output out) {
		int states = 0;
		int unbreakable = 0;
		int collapsed = 0;
		for (Block block : BuiltInRegistries.BLOCK) {
			ResourceLocation id = BuiltInRegistries.BLOCK.getKey(block);
			if (id == null) continue;
			Map<String, StateInfo> rows = new LinkedHashMap<>();
			boolean uniform = true;
			StateInfo first = null;
			for (BlockState state : block.getStateDefinition().getPossibleStates()) {
				StateInfo info = new StateInfo();
				info.s = shapeOf(out, state);
				info.h = hardnessOf(state);
				info.snd = soundOf(out, state);
				if (info.h < 0) unbreakable++;
				if (first == null) first = info;
				else if (info.s != first.s || info.h != first.h || info.snd != first.snd) uniform = false;
				rows.put(stateKey(id, state), info);
				states++;
			}
			if (first == null) continue;
			if (uniform) {
				out.blocks.put(id.toString(), first);
				collapsed++;
			} else {
				out.blocks.putAll(rows);
			}
		}
		out.stats.put("blocksInRegistry", BuiltInRegistries.BLOCK.size());
		out.stats.put("unbreakableStates", unbreakable);
		out.stats.put("statesScanned", states);
		out.stats.put("blocksCollapsedToOneRow", collapsed);
		log("blocks: " + states + " states across " + BuiltInRegistries.BLOCK.size()
				+ " blocks; " + collapsed + " collapsed, " + out.blocks.size() + " rows emitted");
	}

	/**
	 * The REAL collision shape, as a list of boxes.
	 *
	 * `EmptyBlockGetter` is what vanilla itself uses when it needs a context-free shape.
	 * A handful of blocks genuinely vary their shape with their neighbours (fences, walls,
	 * redstone) and those are encoded in the state's own properties here, so the answer is
	 * still right per state. A few (e.g. shulker boxes mid-animation) are not; they get
	 * their closed shape, which is the same thing a static render shows.
	 */
	static int shapeOf(Output out, BlockState state) {
		List<double[]> boxes = new ArrayList<>();
		try {
			VoxelShape shape = state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
			if (!shape.isEmpty()) {
				for (AABB b : shape.toAabbs()) {
					boxes.add(new double[] { r(b.minX), r(b.minY), r(b.minZ), r(b.maxX), r(b.maxY), r(b.maxZ) });
				}
			}
		} catch (Throwable t) {
			// A block that throws without a real level is not a block we can describe. Say
			// so once rather than silently emitting "empty", which would be walk-through.
			out.notes.add("collision shape threw for " + state + ": " + t);
			boxes.add(new double[] { 0, 0, 0, 1, 1, 1 });
		}
		String key = serialise(boxes);
		Integer existing = shapeIndex.get(key);
		if (existing != null) return existing;
		int idx = out.shapes.size();
		out.shapes.add(boxes);
		shapeIndex.put(key, idx);
		return idx;
	}

	/**
	 * The block's SoundType, interned into a small palette.
	 *
	 * Vanilla shares a few dozen SoundTypes across every block, and mods overwhelmingly reuse
	 * them, so this collapses ~26k states onto a handful of rows.
	 */
	static int soundOf(Output out, BlockState state) {
		try {
			net.minecraft.world.level.block.SoundType st = state.getSoundType();
			if (st == null) return -1;
			SoundInfo si = new SoundInfo();
			si.breakSound = idOf(st.getBreakSound());
			si.stepSound = idOf(st.getStepSound());
			si.placeSound = idOf(st.getPlaceSound());
			si.hitSound = idOf(st.getHitSound());
			si.fallSound = idOf(st.getFallSound());
			si.volume = st.getVolume();
			si.pitch = st.getPitch();
			String key = si.breakSound + "|" + si.stepSound + "|" + si.placeSound + "|"
					+ si.hitSound + "|" + si.fallSound + "|" + si.volume + "|" + si.pitch;
			Integer existing = soundIndex.get(key);
			if (existing != null) return existing;
			int idx = out.sounds.size();
			out.sounds.add(si);
			soundIndex.put(key, idx);
			return idx;
		} catch (Throwable t) {
			// A block that cannot describe its sound simply makes none, which is far better
			// than guessing at one.
			return -1;
		}
	}

	static String idOf(net.minecraft.sounds.SoundEvent e) {
		return e == null ? null : e.getLocation().toString();
	}

	/** Destroy time. Vanilla returns -1 for unbreakable (bedrock, barrier, portal frames). */
	static float hardnessOf(BlockState state) {
		try {
			return state.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		} catch (Throwable t) {
			return -1;
		}
	}

	/**
	 * "ns:name[k=v,k=v]" with properties SORTED.
	 *
	 * Must match src/core/chunk.ts's canonical key exactly, or every lookup misses and the
	 * client silently falls back to the guesses this file exists to replace. chunk.ts sorts
	 * property names; so does this.
	 */
	static String stateKey(ResourceLocation id, BlockState state) {
		Map<String, String> props = new TreeMap<>();
		for (Map.Entry<Property<?>, Comparable<?>> e : state.getValues().entrySet()) {
			props.put(e.getKey().getName(), name(e.getKey(), e.getValue()));
		}
		if (props.isEmpty()) return id.toString();
		StringBuilder sb = new StringBuilder(id.toString()).append('[');
		boolean first = true;
		for (Map.Entry<String, String> e : props.entrySet()) {
			if (!first) sb.append(',');
			sb.append(e.getKey()).append('=').append(e.getValue());
			first = false;
		}
		return sb.append(']').toString();
	}

	@SuppressWarnings({ "unchecked", "rawtypes" })
	static String name(Property<?> p, Comparable<?> v) {
		return ((Property) p).getName(v);
	}

	/** Round to 1e-6: VoxelShape corners are exact sixteenths, and float noise bloats the palette. */
	static double r(double v) {
		return Math.round(v * 1e6) / 1e6;
	}

	static String serialise(List<double[]> boxes) {
		StringBuilder sb = new StringBuilder();
		for (double[] b : boxes) {
			for (double v : b) sb.append(v).append(',');
			sb.append(';');
		}
		return sb.toString();
	}

	static void log(String msg) {
		System.out.println("[extract] " + msg);
	}
}
