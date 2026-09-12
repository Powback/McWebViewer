package mcextract;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.Handle;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import org.objectweb.asm.Type;

import java.io.IOException;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * Offline extractor for Minecraft entity model geometry.
 *
 * Vanilla entity models are declarative: EntityModel subclasses expose static factory
 * methods returning a LayerDefinition, built purely out of CubeListBuilder/PartPose calls.
 * None of that touches OpenGL or Minecraft.getInstance(), so we can call it headlessly.
 *
 * Two sources of models:
 *   1. LayerDefinitions.createRoots() -- the authoritative vanilla registry,
 *      ModelLayerLocation ("minecraft:chicken#main") -> LayerDefinition.
 *   2. A bytecode scan (ASM, no class loading) for any static method returning
 *      LayerDefinition, across the client jar and every mod jar. Catches mod models.
 *
 * Entity type -> model layer + texture is resolved by ASM-scanning EntityRenderers
 * (EntityType.X + XRenderer::new pairs) and then each renderer class for the
 * ModelLayers field it bakes and the texture strings it loads.
 *
 * Usage:
 *   java -cp <build>:<deobf client jar>:<libs> mcextract.ExtractModels \
 *        --client <deobf-client.jar> --mods <dir> --out <dir>
 */
public final class ExtractModels {

	static final String LAYER_DEF = "net/minecraft/client/model/geom/builders/LayerDefinition";
	static final String LAYER_DEF_DESC = "L" + LAYER_DEF + ";";

	// ---- reflected handles into the model-builder data classes ----
	static Class<?> cLayerDefinition, cMeshDefinition, cPartDefinition, cCubeDefinition,
			cMaterialDefinition, cCubeDeformation, cPartPose, cUVPair;
	static Field fLdMesh, fLdMaterial, fMdRoot, fPdCubes, fPdPose, fPdChildren;
	static Field fCdOrigin, fCdDims, fCdGrow, fCdMirror, fCdTexCoord, fCdTexScale, fCdFaces, fCdComment;
	static Field fMatX, fMatY, fDefGX, fDefGY, fDefGZ;
	static Field fPpX, fPpY, fPpZ, fPpXR, fPpYR, fPpZR;
	static Field fUvU, fUvV;
	static Field fVecX, fVecY, fVecZ;

	// ---- results ----
	static final Map<String, Object[]> models = new LinkedHashMap<>(); // id -> {texW, texH, rootPartDefinition}
	static final List<String[]> failures = new ArrayList<>();          // {what, reason}
	static int factoriesFound = 0, factoriesInvoked = 0;

	public static void main(String[] argv) throws Exception {
		Map<String, String> args = parseArgs(argv);
		Path clientJar = Paths.get(args.getOrDefault("client", "../.cache/client-1.21.1-deobf.jar"));
		Path modsDir = args.containsKey("mods") ? Paths.get(args.get("mods")) : null;
		Path outDir = Paths.get(args.getOrDefault("out", "out"));
		Path auditFile = args.containsKey("audit") ? Paths.get(args.get("audit")) : null;
		Files.createDirectories(outDir);

		// Build the classloader: deobf client + every library + every mod jar.
		List<URL> urls = new ArrayList<>();
		urls.add(clientJar.toUri().toURL());
		Path libs = Paths.get(args.getOrDefault("libs", "../.cache/libs"));
		if (Files.isDirectory(libs)) for (Path p : listJars(libs)) urls.add(p.toUri().toURL());
		List<Path> modJars = new ArrayList<>();
		if (modsDir != null && Files.isDirectory(modsDir)) {
			modJars = listJars(modsDir);
			for (Path p : modJars) urls.add(p.toUri().toURL());
		}
		URLClassLoader cl = new URLClassLoader(urls.toArray(new URL[0]), ExtractModels.class.getClassLoader());
		Thread.currentThread().setContextClassLoader(cl);
		log("classpath: 1 client jar + " + (urls.size() - 1 - modJars.size()) + " libs + " + modJars.size() + " mod jars");

		initReflection(cl);

		// Registries must exist before renderer/model classes with heavy <clinit> can load.
		Class.forName("net.minecraft.SharedConstants", true, cl).getMethod("tryDetectVersion").invoke(null);
		Class.forName("net.minecraft.server.Bootstrap", true, cl).getMethod("bootStrap").invoke(null);
		log("bootstrap done");

		// ---------- 1. authoritative vanilla layer registry ----------
		Map<String, Object> layerByKey = new TreeMap<>();
		try {
			Class<?> lds = Class.forName("net.minecraft.client.model.geom.LayerDefinitions", true, cl);
			Method createRoots = lds.getMethod("createRoots");
			@SuppressWarnings("unchecked")
			Map<Object, Object> roots = (Map<Object, Object>) createRoots.invoke(null);
			for (Map.Entry<Object, Object> e : roots.entrySet()) {
				layerByKey.put(layerKey(e.getKey()), e.getValue());
			}
			log("LayerDefinitions.createRoots(): " + roots.size() + " layers");
		} catch (Throwable t) {
			failures.add(new String[]{"LayerDefinitions.createRoots()", describe(t)});
			log("createRoots FAILED: " + describe(t));
		}
		for (Map.Entry<String, Object> e : layerByKey.entrySet()) {
			try {
				models.put(e.getKey(), unpackLayer(e.getValue()));
			} catch (Throwable t) {
				failures.add(new String[]{e.getKey(), describe(t)});
			}
		}

		// ---------- 2. bytecode scan for static LayerDefinition factories ----------
		List<Path> scanJars = new ArrayList<>();
		scanJars.add(clientJar);
		scanJars.addAll(modJars);
		Map<String, List<String[]>> candidates = new LinkedHashMap<>(); // jarName -> {className, methodName, desc}
		for (Path jar : scanJars) {
			try {
				candidates.put(jar.getFileName().toString(), scanForFactories(jar));
			} catch (Throwable t) {
				failures.add(new String[]{"scan " + jar.getFileName(), describe(t)});
			}
		}
		Map<String, Integer> perJarFound = new LinkedHashMap<>(), perJarOk = new LinkedHashMap<>();
		for (Map.Entry<String, List<String[]>> e : candidates.entrySet()) {
			int ok = 0;
			for (String[] c : e.getValue()) {
				factoriesFound++;
				String id = "class:" + c[0] + "#" + c[1];
				if (models.containsKey(id)) continue;
				try {
					Object ld = invokeFactory(cl, c[0], c[1], c[2]);
					if (ld == null) throw new IllegalStateException("factory returned null");
					models.put(id, unpackLayer(ld));
					factoriesInvoked++;
					ok++;
				} catch (Throwable t) {
					failures.add(new String[]{id, describe(t)});
				}
			}
			perJarFound.put(e.getKey(), e.getValue().size());
			perJarOk.put(e.getKey(), ok);
		}
		log("factory scan: " + factoriesFound + " found, " + factoriesInvoked + " invoked");

		// ---------- 3. entity type -> renderer -> layer + texture ----------
		Map<String, EntityInfo> entities = resolveEntities(cl, clientJar);
		indexTextures(clientJar, modJars);
		for (EntityInfo e : entities.values()) {
			if (e.textures.isEmpty()) fallbackTexture(e);
			verifyTextures(e);
		}

		// ---------- 3b. modded entity types ----------
		// Driven by every entity a mod DECLARES, not by whichever ones happened to be loaded
		// when somebody ran the audit. A world snapshot is the wrong input for this: mobs
		// spawn, despawn and wander, so a type missing from the snapshot never got resolved
		// and then rendered as nothing for ever. `friendsandfoes:glare` was 28 invisible mobs
		// for exactly that reason, with its geometry already sitting in entity-models.json.
		List<String> needed = new ArrayList<>(entityIdsFromLang(modJars));
		for (String id : (auditFile != null ? readAuditJavaModel(auditFile) : new ArrayList<String>())) {
			if (!needed.contains(id)) needed.add(id);
		}
		log("mod entity types to resolve: " + needed.size());
		resolveModEntities(needed, modJars, entities);

		// ---------- 4. write output ----------
		writeModels(outDir.resolve("entity-models.json"));
		writeEntityIndex(outDir.resolve("entity-index.json"), entities, auditFile);
		writePaintingVariants(cl, outDir.resolve("painting-variants.json"));
		writeReport(outDir.resolve("extract-report.json"), perJarFound, perJarOk, entities, auditFile, layerByKey.size());
		log("done. models=" + models.size() + " failures=" + failures.size());
	}

	// =====================================================================
	// reflection setup
	// =====================================================================
	static void initReflection(ClassLoader cl) throws Exception {
		cLayerDefinition = Class.forName("net.minecraft.client.model.geom.builders.LayerDefinition", true, cl);
		cMeshDefinition = Class.forName("net.minecraft.client.model.geom.builders.MeshDefinition", true, cl);
		cPartDefinition = Class.forName("net.minecraft.client.model.geom.builders.PartDefinition", true, cl);
		cCubeDefinition = Class.forName("net.minecraft.client.model.geom.builders.CubeDefinition", true, cl);
		cMaterialDefinition = Class.forName("net.minecraft.client.model.geom.builders.MaterialDefinition", true, cl);
		cCubeDeformation = Class.forName("net.minecraft.client.model.geom.builders.CubeDeformation", true, cl);
		cPartPose = Class.forName("net.minecraft.client.model.geom.PartPose", true, cl);
		cUVPair = Class.forName("net.minecraft.client.model.geom.builders.UVPair", true, cl);

		fLdMesh = f(cLayerDefinition, "mesh");
		fLdMaterial = f(cLayerDefinition, "material");
		fMdRoot = f(cMeshDefinition, "root");
		fPdCubes = f(cPartDefinition, "cubes");
		fPdPose = f(cPartDefinition, "partPose");
		fPdChildren = f(cPartDefinition, "children");
		fCdComment = f(cCubeDefinition, "comment");
		fCdOrigin = f(cCubeDefinition, "origin");
		fCdDims = f(cCubeDefinition, "dimensions");
		fCdGrow = f(cCubeDefinition, "grow");
		fCdMirror = f(cCubeDefinition, "mirror");
		fCdTexCoord = f(cCubeDefinition, "texCoord");
		fCdTexScale = f(cCubeDefinition, "texScale");
		fCdFaces = f(cCubeDefinition, "visibleFaces");
		fMatX = f(cMaterialDefinition, "xTexSize");
		fMatY = f(cMaterialDefinition, "yTexSize");
		fDefGX = f(cCubeDeformation, "growX");
		fDefGY = f(cCubeDeformation, "growY");
		fDefGZ = f(cCubeDeformation, "growZ");
		fPpX = f(cPartPose, "x"); fPpY = f(cPartPose, "y"); fPpZ = f(cPartPose, "z");
		fPpXR = f(cPartPose, "xRot"); fPpYR = f(cPartPose, "yRot"); fPpZR = f(cPartPose, "zRot");
		fUvU = f(cUVPair, "u"); fUvV = f(cUVPair, "v");
		Class<?> vec3f = Class.forName("org.joml.Vector3f", true, cl);
		fVecX = f(vec3f, "x"); fVecY = f(vec3f, "y"); fVecZ = f(vec3f, "z");
	}

	static Field f(Class<?> c, String name) throws NoSuchFieldException {
		Field fl = c.getDeclaredField(name);
		fl.setAccessible(true);
		return fl;
	}

	// =====================================================================
	// walking the model tree
	// =====================================================================

	/** LayerDefinition -> {texWidth, texHeight, rootPartDefinition} */
	static Object[] unpackLayer(Object layerDef) throws Exception {
		Object mat = fLdMaterial.get(layerDef);
		Object mesh = fLdMesh.get(layerDef);
		Object root = fMdRoot.get(mesh);
		return new Object[]{fMatX.getInt(mat), fMatY.getInt(mat), root};
	}

	@SuppressWarnings("unchecked")
	static void writePart(StringBuilder sb, Object partDef, String indent) throws Exception {
		Object pose = fPdPose.get(partDef);
		sb.append(indent).append("\"pos\": [").append(num(fPpX.getFloat(pose))).append(", ")
				.append(num(fPpY.getFloat(pose))).append(", ").append(num(fPpZ.getFloat(pose))).append("],\n");
		sb.append(indent).append("\"rot\": [").append(num(fPpXR.getFloat(pose))).append(", ")
				.append(num(fPpYR.getFloat(pose))).append(", ").append(num(fPpZR.getFloat(pose))).append("],\n");

		List<Object> cubes = (List<Object>) fPdCubes.get(partDef);
		sb.append(indent).append("\"cubes\": [");
		for (int i = 0; i < cubes.size(); i++) {
			if (i > 0) sb.append(",");
			sb.append("\n").append(indent).append("  ");
			writeCube(sb, cubes.get(i));
		}
		if (!cubes.isEmpty()) sb.append("\n").append(indent);
		sb.append("]");

		Map<String, Object> children = (Map<String, Object>) fPdChildren.get(partDef);
		if (!children.isEmpty()) {
			sb.append(",\n").append(indent).append("\"children\": {\n");
			List<String> keys = new ArrayList<>(children.keySet());
			keys.sort(Comparator.naturalOrder());
			for (int i = 0; i < keys.size(); i++) {
				String k = keys.get(i);
				sb.append(indent).append("  ").append(q(k)).append(": {\n");
				writePart(sb, children.get(k), indent + "    ");
				sb.append("\n").append(indent).append("  }");
				if (i < keys.size() - 1) sb.append(",");
				sb.append("\n");
			}
			sb.append(indent).append("}");
		}
	}

	@SuppressWarnings("unchecked")
	static void writeCube(StringBuilder sb, Object cube) throws Exception {
		Object origin = fCdOrigin.get(cube);
		Object dims = fCdDims.get(cube);
		float ox = fVecX.getFloat(origin), oy = fVecY.getFloat(origin), oz = fVecZ.getFloat(origin);
		float dx = fVecX.getFloat(dims), dy = fVecY.getFloat(dims), dz = fVecZ.getFloat(dims);
		Object grow = fCdGrow.get(cube);
		float gx = fDefGX.getFloat(grow), gy = fDefGY.getFloat(grow), gz = fDefGZ.getFloat(grow);
		Object uv = fCdTexCoord.get(cube);
		Object ts = fCdTexScale.get(cube);
		boolean mirror = fCdMirror.getBoolean(cube);
		String comment = (String) fCdComment.get(cube);
		Set<Object> faces = (Set<Object>) fCdFaces.get(cube);

		sb.append("{\"from\": [").append(num(ox)).append(", ").append(num(oy)).append(", ").append(num(oz))
				.append("], \"to\": [").append(num(ox + dx)).append(", ").append(num(oy + dy)).append(", ").append(num(oz + dz))
				.append("], \"size\": [").append(num(dx)).append(", ").append(num(dy)).append(", ").append(num(dz))
				.append("], \"uv\": [").append(num(fUvU.getFloat(uv))).append(", ").append(num(fUvV.getFloat(uv)))
				.append("], \"grow\": ").append(num(Math.max(gx, Math.max(gy, gz))))
				.append(", \"growXYZ\": [").append(num(gx)).append(", ").append(num(gy)).append(", ").append(num(gz))
				.append("], \"mirror\": ").append(mirror);
		float su = fUvU.getFloat(ts), sv = fUvV.getFloat(ts);
		if (su != 1f || sv != 1f) sb.append(", \"uvScale\": [").append(num(su)).append(", ").append(num(sv)).append("]");
		if (faces != null && faces.size() != 6) {
			sb.append(", \"faces\": [");
			int i = 0;
			for (Object d : faces) {
				if (i++ > 0) sb.append(", ");
				sb.append(q(((Enum<?>) d).name().toLowerCase()));
			}
			sb.append("]");
		}
		if (comment != null && !comment.isEmpty()) sb.append(", \"name\": ").append(q(comment));
		sb.append("}");
	}

	// =====================================================================
	// bytecode scan: static methods returning LayerDefinition
	// =====================================================================
	static List<String[]> scanForFactories(Path jar) throws IOException {
		List<String[]> found = new ArrayList<>();
		try (ZipFile zf = new ZipFile(jar.toFile())) {
			for (java.util.Enumeration<? extends ZipEntry> en = zf.entries(); en.hasMoreElements(); ) {
				ZipEntry e = en.nextElement();
				if (e.isDirectory() || !e.getName().endsWith(".class")) continue;
				byte[] b;
				try { b = RemapJar.readAll(zf.getInputStream(e)); } catch (Throwable t) { continue; }
				if (b.length < 10 || indexOf(b, LAYER_DEF.getBytes(StandardCharsets.UTF_8)) < 0) continue;
				try {
					ClassReader cr = new ClassReader(b);
					String cn = cr.getClassName().replace('/', '.');
					cr.accept(new ClassVisitor(Opcodes.ASM9) {
						@Override public MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] ex) {
							if ((access & Opcodes.ACC_STATIC) != 0 && desc.endsWith(")" + LAYER_DEF_DESC)) {
								found.add(new String[]{cn, name, desc});
							}
							return null;
						}
					}, ClassReader.SKIP_CODE | ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
				} catch (Throwable ignored) { }
			}
		}
		return found;
	}

	/** Invokes a static factory, synthesising plausible default arguments. */
	static Object invokeFactory(ClassLoader cl, String className, String methodName, String desc) throws Exception {
		Class<?> c = Class.forName(className, true, cl);
		Type[] pt = Type.getArgumentTypes(desc);
		outer:
		for (Method m : c.getDeclaredMethods()) {
			if (!m.getName().equals(methodName) || !Modifier.isStatic(m.getModifiers())) continue;
			if (!org.objectweb.asm.Type.getMethodDescriptor(m).equals(desc)) continue;
			Object[] a = new Object[pt.length];
			Class<?>[] ps = m.getParameterTypes();
			for (int i = 0; i < ps.length; i++) {
				Object v = defaultArg(ps[i]);
				if (v == NO_DEFAULT) continue outer;
				a[i] = v;
			}
			m.setAccessible(true);
			return m.invoke(null, a);
		}
		throw new NoSuchMethodException(className + "." + methodName + desc + " (or no synthesisable arguments)");
	}

	static final Object NO_DEFAULT = new Object();

	static Object defaultArg(Class<?> p) {
		if (p == float.class) return 0f;
		if (p == double.class) return 0d;
		if (p == int.class) return 0;
		if (p == long.class) return 0L;
		if (p == boolean.class) return false;
		if (p == short.class) return (short) 0;
		if (p == byte.class) return (byte) 0;
		if (p == char.class) return (char) 0;
		if (cCubeDeformation.isAssignableFrom(p)) {
			try { return f(cCubeDeformation, "NONE").get(null); } catch (Throwable t) { return null; }
		}
		if (p.isEnum()) {
			Object[] cs = p.getEnumConstants();
			return cs != null && cs.length > 0 ? cs[0] : null;
		}
		return null; // reference types: null and hope the factory does not dereference
	}

	// =====================================================================
	// entity type -> renderer -> model layer + texture
	// =====================================================================
	static final class EntityInfo {
		String id;
		String renderer;
		final List<String> layers = new ArrayList<>();
		final List<String> textures = new ArrayList<>();
		String primaryLayer;
		String primaryTexture;
		String how = "";
		String texturesVerified = "0/0";
	}

	static Map<String, EntityInfo> resolveEntities(ClassLoader cl, Path clientJar) {
		Map<String, EntityInfo> out = new TreeMap<>();
		Map<String, String> entityFieldToRenderer = new LinkedHashMap<>();
		Map<String, byte[]> classBytes = new HashMap<>();
		try (ZipFile zf = new ZipFile(clientJar.toFile())) {
			for (java.util.Enumeration<? extends ZipEntry> en = zf.entries(); en.hasMoreElements(); ) {
				ZipEntry e = en.nextElement();
				String n = e.getName();
				if (!n.endsWith(".class")) continue;
				if (!n.startsWith("net/minecraft/client/renderer/")) continue;
				classBytes.put(n.substring(0, n.length() - 6), RemapJar.readAll(zf.getInputStream(e)));
			}
		} catch (Throwable t) {
			failures.add(new String[]{"read renderer classes", describe(t)});
			return out;
		}

		// -- EntityRenderers: pairs of (GETSTATIC EntityType.X, invokedynamic -> renderer factory) --
		// The factory is usually a method reference (XRenderer::new), but sometimes a lambda body
		// living on EntityRenderers itself (ctx -> new MinecartRenderer<>(ctx, ModelLayers.MINECART)).
		// In the latter case we follow the lambda method and take the class it instantiates.
		final String ERS = "net/minecraft/client/renderer/entity/EntityRenderers";
		byte[] er = classBytes.get(ERS);
		Map<String, String> lambdaToRenderer = new HashMap<>();
		Map<String, Set<String>> lambdaToLayerFields = new HashMap<>();
		Map<String, String[]> entityFieldToHandle = new LinkedHashMap<>();
		if (er != null) {
			try {
				new ClassReader(er).accept(new ClassVisitor(Opcodes.ASM9) {
					@Override public MethodVisitor visitMethod(int a, final String mname, String d, String s, String[] x) {
						return new MethodVisitor(Opcodes.ASM9) {
							String last = null;
							@Override public void visitFieldInsn(int op, String owner, String name, String desc) {
								if (op == Opcodes.GETSTATIC && owner.equals("net/minecraft/world/entity/EntityType")) last = name;
								// the layer is often passed into the renderer from the lambda body
								if (op == Opcodes.GETSTATIC && owner.equals("net/minecraft/client/model/geom/ModelLayers"))
									lambdaToLayerFields.computeIfAbsent(mname, k -> new LinkedHashSet<>()).add(name);
							}
							@Override public void visitTypeInsn(int op, String type) {
								// inside a lambda body: remember which renderer it constructs
								if (op == Opcodes.NEW && type.endsWith("Renderer") && type.contains("/renderer/"))
									lambdaToRenderer.putIfAbsent(mname, type);
							}
							@Override public void visitInvokeDynamicInsn(String name, String desc, Handle bsm, Object... bsmArgs) {
								if (last == null) return;
								for (Object o : bsmArgs) {
									if (o instanceof Handle h && (h.getOwner().contains("/renderer/") || h.getOwner().equals(ERS))) {
										entityFieldToHandle.put(last, new String[]{h.getOwner(), h.getName()});
										last = null;
										return;
									}
								}
							}
						};
					}
				}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
				for (Map.Entry<String, String[]> e : entityFieldToHandle.entrySet()) {
					String owner = e.getValue()[0];
					if (owner.equals(ERS)) {
						String r = lambdaToRenderer.get(e.getValue()[1]);
						if (r != null) owner = r;
					}
					entityFieldToRenderer.put(e.getKey(), owner);
				}
			} catch (Throwable t) {
				failures.add(new String[]{"scan EntityRenderers", describe(t)});
			}
		}

		// -- ModelLayers static fields: field name -> "ns:path#layer" --
		Map<String, String> modelLayerFields = new HashMap<>();
		try {
			Class<?> ml = Class.forName("net.minecraft.client.model.geom.ModelLayers", true, cl);
			Class<?> mll = Class.forName("net.minecraft.client.model.geom.ModelLayerLocation", true, cl);
			for (Field fl : ml.getDeclaredFields()) {
				if (Modifier.isStatic(fl.getModifiers()) && mll.isAssignableFrom(fl.getType())) {
					fl.setAccessible(true);
					modelLayerFields.put(fl.getName(), layerKey(fl.get(null)));
					modelLayerFieldKeys.put(fl.getName(), layerKey(fl.get(null)));
				}
			}
		} catch (Throwable t) {
			failures.add(new String[]{"reflect ModelLayers", describe(t)});
		}

		// -- EntityType static fields -> registry id --
		Map<String, String> entityFieldToId = new HashMap<>();
		try {
			Class<?> et = Class.forName("net.minecraft.world.entity.EntityType", true, cl);
			Class<?> reg = Class.forName("net.minecraft.core.registries.BuiltInRegistries", true, cl);
			Field pf = reg.getField("ENTITY_TYPE");
			Object registry = pf.get(null);
			Method getKey = null;
			for (Method m : registry.getClass().getMethods()) {
				if (m.getName().equals("getKey") && m.getParameterCount() == 1
						&& m.getReturnType().getName().equals("net.minecraft.resources.ResourceLocation")) { getKey = m; break; }
			}
			for (Field fl : et.getDeclaredFields()) {
				if (Modifier.isStatic(fl.getModifiers()) && et.isAssignableFrom(fl.getType())) {
					fl.setAccessible(true);
					Object v = fl.get(null);
					Object k = getKey != null ? getKey.invoke(registry, v) : null;
					if (k != null) entityFieldToId.put(fl.getName(), k.toString());
				}
			}
		} catch (Throwable t) {
			failures.add(new String[]{"reflect EntityType ids", describe(t)});
		}

		// -- for each renderer: which ModelLayers fields + texture strings does it reference --
		for (Map.Entry<String, String> e : entityFieldToRenderer.entrySet()) {
			EntityInfo info = new EntityInfo();
			info.id = entityFieldToId.getOrDefault(e.getKey(), "minecraft:" + e.getKey().toLowerCase());
			info.renderer = e.getValue().replace('/', '.');
			info.how = entityFieldToId.containsKey(e.getKey()) ? "registry+bytecode" : "bytecode(field-name id)";

			Set<String> layerFields = new LinkedHashSet<>(), textures = new LinkedHashSet<>();
			String[] handle = entityFieldToHandle.get(e.getKey());
			if (handle != null && handle[0].equals(ERS))
				layerFields.addAll(lambdaToLayerFields.getOrDefault(handle[1], java.util.Collections.emptySet()));
			collectRendererRefs(classBytes, e.getValue(), layerFields, textures, new LinkedHashSet<>(), 0);
			for (String lf : layerFields) {
				String k = modelLayerFields.get(lf);
				if (k != null && !info.layers.contains(k)) info.layers.add(k);
			}
			info.textures.addAll(textures);
			for (String l : info.layers) {
				if (l.endsWith("#main")) { info.primaryLayer = l; break; }
			}
			if (info.primaryLayer == null && !info.layers.isEmpty()) info.primaryLayer = info.layers.get(0);
			// prefer a layer whose model id equals the entity id
			for (String l : info.layers) {
				if (l.startsWith(info.id + "#")) { info.primaryLayer = l; break; }
			}
			for (String t : info.textures) {
				String base = t.substring(t.lastIndexOf('/') + 1);
				if (base.equals(info.id.substring(info.id.indexOf(':') + 1) + ".png")) { info.primaryTexture = t; break; }
			}
			if (info.primaryTexture == null && !info.textures.isEmpty()) info.primaryTexture = info.textures.get(0);
			out.put(info.id, info);
		}
		log("entity renderers resolved: " + out.size());
		return out;
	}

	/** Walks a renderer class and its net.minecraft superclasses for ModelLayers refs and texture strings. */
	static void collectRendererRefs(Map<String, byte[]> classBytes, String internalName,
	                                Set<String> layerFields, Set<String> textures, Set<String> seen, int depth) {
		if (depth > 6 || !seen.add(internalName)) return;
		byte[] b = classBytes.get(internalName);
		if (b == null) return;
		try {
			ClassReader cr = new ClassReader(b);
			String[] sup = {cr.getSuperName()};
			cr.accept(new ClassVisitor(Opcodes.ASM9) {
				@Override public MethodVisitor visitMethod(int a, String n, String d, String s, String[] x) {
					return new MethodVisitor(Opcodes.ASM9) {
						@Override public void visitFieldInsn(int op, String owner, String name, String desc) {
							if (op == Opcodes.GETSTATIC && owner.equals("net/minecraft/client/model/geom/ModelLayers"))
								layerFields.add(name);
						}
						@Override public void visitLdcInsn(Object v) {
							// A `%s` here is a format string the renderer expands per variant, not a
							// file — see isTemplatePath.
							if (v instanceof String str && str.startsWith("textures/entity")
								&& str.endsWith(".png") && !isTemplatePath(str))
								textures.add("assets/minecraft/" + str);
						}
					};
				}
			}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
			if (sup[0] != null && sup[0].startsWith("net/minecraft/"))
				collectRendererRefs(classBytes, sup[0], layerFields, textures, seen, depth + 1);
		} catch (Throwable ignored) { }
	}

	// =====================================================================
	// modded entity types
	// =====================================================================

	/** asset path ("assets/ns/textures/...") -> jar file name. Populated from client + mod jars. */
	static final Map<String, String> assetIndex = new HashMap<>();
	/** internal class name -> jar path, for classes named *Renderer in mod jars. */
	static final Map<String, Path> modRendererClasses = new LinkedHashMap<>();

	static void indexTextures(Path clientJar, List<Path> modJars) {
		List<Path> all = new ArrayList<>();
		all.add(clientJar);
		all.addAll(modJars);
		for (Path jar : all) {
			try (ZipFile zf = new ZipFile(jar.toFile())) {
				for (java.util.Enumeration<? extends ZipEntry> en = zf.entries(); en.hasMoreElements(); ) {
					ZipEntry e = en.nextElement();
					String n = e.getName();
					if (n.startsWith("assets/") && n.endsWith(".png")) assetIndex.putIfAbsent(n, jar.getFileName().toString());
					else if (n.endsWith("Renderer.class") && !jar.equals(clientJar))
						modRendererClasses.putIfAbsent(n.substring(0, n.length() - 6), jar);
				}
			} catch (Throwable t) {
				failures.add(new String[]{"index " + jar.getFileName(), describe(t)});
			}
		}
	}

	/**
	 * Some renderers build their texture path from a data-driven variant registry rather than a
	 * string constant (wolf, llama, horse, squid...). Fall back to any shipped texture whose file
	 * name equals the entity id; flagged in the output so it is never mistaken for a real read.
	 */
	static void fallbackTexture(EntityInfo e) {
		String name = e.id.substring(e.id.indexOf(':') + 1);
		String ns = e.id.substring(0, e.id.indexOf(':'));
		String suffix = "/" + name + ".png";
		List<String> hits = new ArrayList<>();
		for (String a : assetIndex.keySet()) {
			if (a.startsWith("assets/" + ns + "/textures/entity/") && a.endsWith(suffix)) hits.add(a);
		}
		hits.sort(Comparator.comparingInt(String::length));
		if (!hits.isEmpty()) {
			e.textures.addAll(hits);
			e.primaryTexture = hits.get(0);
			e.how = e.how + " + texture by filename heuristic";
		}
	}

	/**
	 * A `%s` in a texture path is a FORMAT STRING, not a file.
	 *
	 * Renderers that pick a texture per variant build the path at runtime, and recording the
	 * unexpanded template as if it were an asset leaves a sprite that can never be found —
	 * one permanently "missing" entry in every atlas, and an entity that draws nothing. The
	 * variant tables in physics.json carry the real paths; dropping the template here lets
	 * the renderer's variant fallback supply one instead.
	 */
	static boolean isTemplatePath(String path) {
		return path != null && path.contains("%");
	}

	static void verifyTextures(EntityInfo e) {
		List<String> ok = new ArrayList<>();
		for (String t : e.textures) if (assetIndex.containsKey(t)) ok.add(t);
		e.texturesVerified = ok.size() + "/" + e.textures.size();
		if (e.primaryTexture != null && !assetIndex.containsKey(e.primaryTexture) && !ok.isEmpty())
			e.primaryTexture = ok.get(0);
	}

	/**
	 * Renderers for modded entities are registered through NeoForge events, which we cannot
	 * replay offline. Instead we locate the renderer class by naming convention
	 * (friendsandfoes:mauler -> MaulerEntityRenderer / MaulerRenderer) and then read the
	 * model class + texture strings out of its bytecode. Flagged as heuristic in the output.
	 */
	static void resolveModEntities(List<String> needed, List<Path> modJars, Map<String, EntityInfo> entities) {
		for (String id : needed) {
			if (entities.containsKey(id)) continue;
			int c = id.indexOf(':');
			if (c < 0) continue;
			String ns = id.substring(0, c), path = id.substring(c + 1);
			String pascal = pascal(path);
			EntityInfo info = new EntityInfo();
			info.id = id;

			// manual overrides for renderers that delegate to another entity's renderer entirely
			if (id.equals("corpse:corpse")) {
				info.renderer = "de.maxhenkel.corpse.entities.CorpseRenderer";
				info.layers.add("minecraft:player#main");
				info.layers.add("minecraft:player_slim#main");
				info.layers.add("minecraft:skeleton#main");
				info.primaryLayer = "minecraft:player#main";
				info.textures.add("assets/minecraft/textures/entity/player/wide/steve.png");
				info.textures.add("assets/minecraft/textures/entity/skeleton/skeleton.png");
				info.primaryTexture = "assets/minecraft/textures/entity/player/wide/steve.png";
				info.how = "manual: CorpseRenderer delegates to the vanilla player renderer (DummyPlayer) "
						+ "or skeleton renderer (DummySkeleton); texture is the dead player's skin at runtime";
				verifyTextures(info);
				entities.put(id, info);
				continue;
			}

			Path jar = null;
			String cls = null;
			for (String suffix : new String[]{"EntityRenderer", "Renderer"}) {
				for (Map.Entry<String, Path> e : modRendererClasses.entrySet()) {
					String simple = e.getKey().substring(e.getKey().lastIndexOf('/') + 1);
					if (!simple.equals(pascal + suffix)) continue;
					if (jar == null || e.getValue().getFileName().toString().toLowerCase().contains(ns)) {
						jar = e.getValue();
						cls = e.getKey();
					}
				}
				if (cls != null) break;
			}
			if (cls == null) {
				info.how = "unresolved: no *Renderer class named " + pascal + "[Entity]Renderer in any mod jar";
				entities.put(id, info);
				continue;
			}
			info.renderer = cls.replace('/', '.');
			info.how = "heuristic: renderer class matched by name, model+texture read from its bytecode";

			Set<String> layerFields = new LinkedHashSet<>(), modelClasses = new LinkedHashSet<>(), strings = new LinkedHashSet<>();
			try (ZipFile zf = new ZipFile(jar.toFile())) {
				byte[] b = RemapJar.readAll(zf.getInputStream(zf.getEntry(cls + ".class")));
				new ClassReader(b).accept(new ClassVisitor(Opcodes.ASM9) {
					@Override public MethodVisitor visitMethod(int a, String n, String d, String s, String[] x) {
						return new MethodVisitor(Opcodes.ASM9) {
							@Override public void visitFieldInsn(int op, String owner, String name, String desc) {
								if (op == Opcodes.GETSTATIC && owner.equals("net/minecraft/client/model/geom/ModelLayers"))
									layerFields.add(name);
							}
							@Override public void visitTypeInsn(int op, String type) {
								if (op == Opcodes.NEW && type.endsWith("Model")) modelClasses.add(type.replace('/', '.'));
							}
							@Override public void visitLdcInsn(Object v) {
								// Same template rule as the vanilla scan; see isTemplatePath.
							if (v instanceof String str && str.startsWith("textures/")
								&& str.endsWith(".png") && !isTemplatePath(str)) strings.add(str);
							}
						};
					}
				}, ClassReader.SKIP_DEBUG | ClassReader.SKIP_FRAMES);
			} catch (Throwable t) {
				failures.add(new String[]{"scan mod renderer " + cls, describe(t)});
			}

			// prefer a vanilla ModelLayers reference, else a model class we extracted
			for (String lf : layerFields) {
				String k = modelLayerFieldKeys.get(lf);
				if (k != null && !info.layers.contains(k)) info.layers.add(k);
			}
			for (String mc : modelClasses) {
				for (String mid : models.keySet()) {
					if (mid.startsWith("class:" + mc + "#") && !info.layers.contains(mid)) info.layers.add(mid);
				}
			}
			if (!info.layers.isEmpty()) info.primaryLayer = info.layers.get(0);

			for (String s : strings) {
				String a = "assets/" + ns + "/" + s;
				if (!assetIndex.containsKey(a)) a = "assets/minecraft/" + s;
				info.textures.add(a);
			}
			// fall back to any texture the mod ships under textures/entity/<path>
			if (info.textures.isEmpty()) {
				for (String a : assetIndex.keySet()) {
					if (a.startsWith("assets/" + ns + "/textures/entity/" + path)) info.textures.add(a);
				}
			}
			verifyTextures(info);
			if (!info.textures.isEmpty()) info.primaryTexture = info.textures.get(0);
			entities.put(id, info);
		}
	}

	static final Map<String, String> modelLayerFieldKeys = new HashMap<>();

	/** Entity types that genuinely have no LayerDefinition, and what to render instead. */
	static final Map<String, String> NOTES = new HashMap<>();
	static {
		NOTES.put("minecraft:item", "No entity model. ItemEntityRenderer renders the item's own "
				+ "item/block model (BakedModel) as a billboard/extruded quad. Use the existing block/item model pipeline.");
		NOTES.put("minecraft:item_frame", "No entity model. ItemFrameRenderer renders the block models "
				+ "minecraft:block/item_frame and minecraft:block/item_frame_map (present in the client jar under "
				+ "assets/minecraft/models/block/), plus the contained item. Use the block model pipeline.");
		NOTES.put("minecraft:painting", "No entity model. PaintingRenderer emits a flat WxH quad from the "
				+ "PAINTING_VARIANT registry; see painting-variants.json for every variant's size and texture.");
		NOTES.put("minecraft:falling_block", "Rendered as the block state's own block model.");
	}

	static String pascal(String snake) {
		StringBuilder sb = new StringBuilder();
		for (String p : snake.split("_")) {
			if (p.isEmpty()) continue;
			sb.append(Character.toUpperCase(p.charAt(0))).append(p.substring(1));
		}
		return sb.toString();
	}

	/**
	 * Paintings and item frames have no LayerDefinition at all; paintings are a flat quad
	 * whose size and texture come from the PAINTING_VARIANT registry, which is pure data.
	 */
	static void writePaintingVariants(ClassLoader cl, Path file) {
		try {
			// PAINTING_VARIANT is a datapack registry, so it is not in BuiltInRegistries. Its
			// built-in contents come from PaintingVariants.bootstrap(BootstrapContext), which we
			// drive with a recording Proxy -- again pure data, no world or server needed.
			Class<?> ctxIface = Class.forName("net.minecraft.data.worldgen.BootstrapContext", true, cl);
			Class<?> variants = Class.forName("net.minecraft.world.entity.decoration.PaintingVariants", true, cl);
			final List<Object[]> captured = new ArrayList<>();
			Object proxy = java.lang.reflect.Proxy.newProxyInstance(cl, new Class<?>[]{ctxIface}, (p, m, a) -> {
				if (m.getName().equals("register") && a != null && a.length >= 2) captured.add(new Object[]{a[0], a[1]});
				return null;
			});
			Method bootstrap = null;
			for (Method m : variants.getDeclaredMethods()) {
				if (m.getParameterCount() == 1 && ctxIface.isAssignableFrom(m.getParameterTypes()[0])) { bootstrap = m; break; }
			}
			bootstrap.setAccessible(true);
			bootstrap.invoke(null, proxy);

			List<String> rows = new ArrayList<>();
			for (Object[] kv : captured) {
				Object id = kv[0].getClass().getMethod("location").invoke(kv[0]);
				Object pv = kv[1];
				int w = (int) pv.getClass().getMethod("width").invoke(pv);
				int h = (int) pv.getClass().getMethod("height").invoke(pv);
				String ap = String.valueOf(pv.getClass().getMethod("assetId").invoke(pv));
				String path = "assets/" + ap.substring(0, ap.indexOf(':')) + "/textures/painting/"
						+ ap.substring(ap.indexOf(':') + 1) + ".png";
				rows.add("  " + q(String.valueOf(id)) + ": {\"width\": " + w + ", \"height\": " + h
						+ ", \"texture\": " + q(path) + ", \"textureExists\": " + assetIndex.containsKey(path) + "}");
			}
			rows.sort(Comparator.naturalOrder());
			Files.write(file, ("{\n" + String.join(",\n", rows) + "\n}\n").getBytes(StandardCharsets.UTF_8));
			log("wrote " + file + " (" + rows.size() + " painting variants)");
		} catch (Throwable t) {
			failures.add(new String[]{"painting variants", describe(t)});
			log("painting variants FAILED: " + describe(t));
		}
	}

	// =====================================================================
	// output
	// =====================================================================
	static void writeModels(Path file) throws Exception {
		StringBuilder sb = new StringBuilder(1 << 22);
		sb.append("{\n");
		List<String> ids = new ArrayList<>(models.keySet());
		ids.sort(Comparator.naturalOrder());
		for (int i = 0; i < ids.size(); i++) {
			String id = ids.get(i);
			Object[] v = models.get(id);
			sb.append("  ").append(q(id)).append(": {\n");
			sb.append("    \"texWidth\": ").append(v[0]).append(",\n");
			sb.append("    \"texHeight\": ").append(v[1]).append(",\n");
			sb.append("    \"parts\": {\n");
			// The LayerDefinition root itself is an unnamed container; emit its children as
			// the top-level parts, and any cubes it holds directly under "root".
			@SuppressWarnings("unchecked")
			Map<String, Object> children = (Map<String, Object>) fPdChildren.get(v[2]);
			@SuppressWarnings("unchecked")
			List<Object> rootCubes = (List<Object>) fPdCubes.get(v[2]);
			List<String> keys = new ArrayList<>(children.keySet());
			keys.sort(Comparator.naturalOrder());
			List<String> emit = new ArrayList<>(keys);
			boolean hasRootCubes = !rootCubes.isEmpty();
			if (hasRootCubes) emit.add(0, "__root__");
			for (int j = 0; j < emit.size(); j++) {
				String k = emit.get(j);
				Object pd = k.equals("__root__") ? v[2] : children.get(k);
				sb.append("      ").append(q(k)).append(": {\n");
				writePart(sb, pd, "        ");
				sb.append("\n      }");
				if (j < emit.size() - 1) sb.append(",");
				sb.append("\n");
			}
			sb.append("    }\n  }");
			if (i < ids.size() - 1) sb.append(",");
			sb.append("\n");
		}
		sb.append("}\n");
		Files.write(file, sb.toString().getBytes(StandardCharsets.UTF_8));
		log("wrote " + file + " (" + ids.size() + " models, " + sb.length() / 1024 + " KiB)");
	}

	static void writeEntityIndex(Path file, Map<String, EntityInfo> entities, Path auditFile) throws Exception {
		StringBuilder sb = new StringBuilder();
		sb.append("{\n");
		List<String> ids = new ArrayList<>(entities.keySet());
		for (int i = 0; i < ids.size(); i++) {
			EntityInfo e = entities.get(ids.get(i));
			sb.append("  ").append(q(e.id)).append(": {\n");
			// An entity we could not resolve has no renderer, and writing the index must not
			// die on it — the row is the RECORD that it was tried and failed, which is more
			// use than a crash that loses the whole index. Latent until the needed list was
			// widened past the ids that all happened to resolve.
			sb.append("    \"renderer\": ").append(e.renderer == null ? "null" : q(e.renderer)).append(",\n");
			sb.append("    \"model\": ").append(e.primaryLayer == null ? "null" : q(e.primaryLayer)).append(",\n");
			sb.append("    \"texture\": ").append(e.primaryTexture == null ? "null" : q(e.primaryTexture)).append(",\n");
			sb.append("    \"hasGeometry\": ").append(e.primaryLayer != null && models.containsKey(e.primaryLayer)).append(",\n");
			sb.append("    \"allModels\": ").append(arr(e.layers)).append(",\n");
			sb.append("    \"allTextures\": ").append(arr(e.textures)).append(",\n");
			sb.append("    \"texturesVerifiedInJars\": ").append(q(e.texturesVerified)).append(",\n");
			String note = NOTES.get(e.id);
			if (note != null) sb.append("    \"note\": ").append(q(note)).append(",\n");
			sb.append("    \"resolvedBy\": ").append(q(e.how)).append("\n");
			sb.append("  }");
			if (i < ids.size() - 1) sb.append(",");
			sb.append("\n");
		}
		sb.append("}\n");
		Files.write(file, sb.toString().getBytes(StandardCharsets.UTF_8));
		log("wrote " + file + " (" + ids.size() + " entity types)");
	}

	static void writeReport(Path file, Map<String, Integer> found, Map<String, Integer> ok,
	                        Map<String, EntityInfo> entities, Path auditFile, int layerCount) throws Exception {
		List<String> needed = auditFile != null ? readAuditJavaModel(auditFile) : new ArrayList<>();
		StringBuilder sb = new StringBuilder();
		sb.append("{\n");
		sb.append("  \"jdk\": ").append(q(System.getProperty("java.version"))).append(",\n");
		sb.append("  \"models\": ").append(models.size()).append(",\n");
		sb.append("  \"vanillaLayerRegistry\": ").append(layerCount).append(",\n");
		sb.append("  \"factoriesFound\": ").append(factoriesFound).append(",\n");
		sb.append("  \"factoriesInvoked\": ").append(factoriesInvoked).append(",\n");
		sb.append("  \"perJar\": {\n");
		List<String> jn = new ArrayList<>(found.keySet());
		jn.removeIf(k -> found.get(k) == 0);
		for (int i = 0; i < jn.size(); i++) {
			sb.append("    ").append(q(jn.get(i))).append(": {\"found\": ").append(found.get(jn.get(i)))
					.append(", \"invoked\": ").append(ok.getOrDefault(jn.get(i), 0)).append("}");
			if (i < jn.size() - 1) sb.append(",");
			sb.append("\n");
		}
		sb.append("  },\n");
		sb.append("  \"neededEntityTypes\": ").append(arr(needed)).append(",\n");
		List<String> cov = new ArrayList<>(), miss = new ArrayList<>(), byDesign = new ArrayList<>();
		for (String n : needed) {
			EntityInfo e = entities.get(n);
			boolean has = e != null && e.primaryLayer != null && models.containsKey(e.primaryLayer);
			if (has) cov.add(n);
			else if (NOTES.containsKey(n)) byDesign.add(n);
			else miss.add(n);
		}
		sb.append("  \"neededCount\": ").append(needed.size()).append(",\n");
		sb.append("  \"covered\": ").append(arr(cov)).append(",\n");
		sb.append("  \"noLayerDefinitionByDesign\": ").append(arr(byDesign)).append(",\n");
		sb.append("  \"notCovered\": ").append(arr(miss)).append(",\n");
		sb.append("  \"failures\": [\n");
		for (int i = 0; i < failures.size(); i++) {
			sb.append("    {\"what\": ").append(q(failures.get(i)[0])).append(", \"reason\": ").append(q(failures.get(i)[1])).append("}");
			if (i < failures.size() - 1) sb.append(",");
			sb.append("\n");
		}
		sb.append("  ]\n}\n");
		Files.write(file, sb.toString().getBytes(StandardCharsets.UTF_8));
		log("wrote " + file);
	}

	/**
	 * The entity types the browser renderer cannot draw. Reads both "java-model" (still needs
	 * geometry) and "extracted-model" (already fed from this harness), so re-running after the
	 * renderer has adopted the output still reports the full set rather than an empty one.
	 */
	/**
	 * Every entity id the mod jars declare, from their own language files.
	 *
	 * `assets/<ns>/lang/en_us.json` carries an `entity.<ns>.<name>` key for every entity a
	 * mod registers — it has to, or the entity has no name in-game. That makes it a complete,
	 * offline, world-independent list, which is exactly what the renderer resolution needs
	 * and what the audit file was a poor substitute for. Measured on this pack: 141 ids.
	 */
	static Set<String> entityIdsFromLang(List<Path> modJars) {
		Set<String> out = new java.util.TreeSet<>();
		java.util.regex.Pattern key =
			java.util.regex.Pattern.compile("\"entity\\.([a-z0-9_]+)\\.([a-z0-9_/]+)\"");
		for (Path jar : modJars) {
			try (ZipFile zf = new ZipFile(jar.toFile())) {
				for (java.util.Enumeration<? extends ZipEntry> en = zf.entries(); en.hasMoreElements(); ) {
					ZipEntry e = en.nextElement();
					String n = e.getName();
					if (!n.startsWith("assets/") || !n.endsWith("/lang/en_us.json")) continue;
					String text = new String(RemapJar.readAll(zf.getInputStream(e)), StandardCharsets.UTF_8);
					java.util.regex.Matcher m = key.matcher(text);
					while (m.find()) {
						// `entity.minecraft.*` in a mod's lang file is an override of a vanilla
						// name, not a new entity, and vanilla is already resolved from bytecode.
						if (!"minecraft".equals(m.group(1))) out.add(m.group(1) + ":" + m.group(2));
					}
				}
			} catch (Throwable ignored) { /* a jar we cannot read contributes nothing */ }
		}
		return out;
	}

	static List<String> readAuditJavaModel(Path audit) {
		List<String> out = new ArrayList<>();
		try {
			String s = new String(Files.readAllBytes(audit), StandardCharsets.UTF_8);
			for (String bucket : new String[]{"\"java-model\"", "\"extracted-model\""}) {
				int i = s.indexOf(bucket);
				if (i < 0) continue;
				int a = s.indexOf('[', i), b = s.indexOf(']', a);
				for (String t : s.substring(a + 1, b).split(",")) {
					t = t.trim();
					if (t.startsWith("\"")) {
						String id = t.substring(1, t.length() - 1);
						if (!out.contains(id)) out.add(id);
					}
				}
			}
		} catch (Throwable ignored) { }
		return out;
	}

	// =====================================================================
	// helpers
	// =====================================================================
	static String layerKey(Object modelLayerLocation) {
		try {
			Method gm = modelLayerLocation.getClass().getMethod("getModel");
			Method gl = modelLayerLocation.getClass().getMethod("getLayer");
			return gm.invoke(modelLayerLocation) + "#" + gl.invoke(modelLayerLocation);
		} catch (Throwable t) {
			return String.valueOf(modelLayerLocation);
		}
	}

	static String num(float v) {
		if (v == Math.rint(v) && Math.abs(v) < 1e7) return String.valueOf((long) v);
		String s = String.format(java.util.Locale.ROOT, "%.5f", v);
		while (s.endsWith("0")) s = s.substring(0, s.length() - 1);
		if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
		return s;
	}

	static String q(String s) {
		StringBuilder sb = new StringBuilder("\"");
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
				case '"': sb.append("\\\""); break;
				case '\\': sb.append("\\\\"); break;
				case '\n': sb.append("\\n"); break;
				case '\r': sb.append("\\r"); break;
				case '\t': sb.append("\\t"); break;
				default:
					if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
					else sb.append(c);
			}
		}
		return sb.append('"').toString();
	}

	static String arr(Collection<String> c) {
		StringBuilder sb = new StringBuilder("[");
		int i = 0;
		for (String s : c) { if (i++ > 0) sb.append(", "); sb.append(q(s)); }
		return sb.append(']').toString();
	}

	static String describe(Throwable t) {
		while (t instanceof java.lang.reflect.InvocationTargetException && t.getCause() != null) t = t.getCause();
		if (t instanceof ExceptionInInitializerError && t.getCause() != null) {
			Throwable c = t.getCause();
			return "ExceptionInInitializerError: " + c.getClass().getSimpleName() + ": " + trunc(c.getMessage());
		}
		return t.getClass().getSimpleName() + (t.getMessage() != null ? ": " + trunc(t.getMessage()) : "");
	}

	static String trunc(String s) {
		if (s == null) return "";
		s = s.replace('\n', ' ');
		return s.length() > 200 ? s.substring(0, 200) + "..." : s;
	}

	static int indexOf(byte[] hay, byte[] needle) {
		outer:
		for (int i = 0; i <= hay.length - needle.length; i++) {
			for (int j = 0; j < needle.length; j++) if (hay[i + j] != needle[j]) continue outer;
			return i;
		}
		return -1;
	}

	static List<Path> listJars(Path dir) throws IOException {
		List<Path> out = new ArrayList<>();
		try (var s = Files.list(dir)) {
			s.filter(p -> p.toString().endsWith(".jar")).sorted().forEach(out::add);
		}
		return out;
	}

	static Map<String, String> parseArgs(String[] argv) {
		Map<String, String> m = new HashMap<>();
		for (int i = 0; i < argv.length - 1; i++) if (argv[i].startsWith("--")) m.put(argv[i].substring(2), argv[i + 1]);
		return m;
	}

	static void log(String s) { System.out.println("[extract] " + s); }
}
