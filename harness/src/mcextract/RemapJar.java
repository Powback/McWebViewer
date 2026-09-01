package mcextract;

import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.commons.ClassRemapper;
import org.objectweb.asm.commons.Remapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/**
 * Deobfuscates the shipped Minecraft client jar using Mojang's ProGuard mappings.
 *
 * Why: mod jars (NeoForge) are compiled against OFFICIAL ("Mojang mapped") names, so
 * their model classes cannot link against the obfuscated client jar. Remapping the
 * client once makes both vanilla and mod model classes loadable by plain reflection.
 *
 * Member renaming is inheritance-aware: a call site may reference an inherited member
 * through a subclass owner, so we walk the superclass/interface chain to find the
 * declaring class's mapping.
 *
 * Usage: java -cp ... mcextract.RemapJar <in.jar> <mappings.txt> <out.jar>
 */
public final class RemapJar {

	private static final class Hier {
		String superName;
		String[] interfaces;
	}

	public static void main(String[] args) throws Exception {
		Path in = Paths.get(args[0]);
		Path mapFile = Paths.get(args[1]);
		Path out = Paths.get(args[2]);

		System.out.println("[remap] loading mappings " + mapFile);
		ProguardMappings m = ProguardMappings.load(mapFile);
		System.out.println("[remap] " + m.byObf.size() + " classes in mappings");

		Map<String, byte[]> classes = new LinkedHashMap<>();
		Map<String, byte[]> resources = new LinkedHashMap<>();
		try (ZipFile zf = new ZipFile(in.toFile())) {
			for (java.util.Enumeration<? extends ZipEntry> en = zf.entries(); en.hasMoreElements(); ) {
				ZipEntry e = en.nextElement();
				if (e.isDirectory()) continue;
				String n = e.getName();
				if (n.startsWith("META-INF/") && (n.endsWith(".SF") || n.endsWith(".RSA") || n.endsWith(".DSA"))) continue;
				byte[] data = readAll(zf.getInputStream(e));
				if (n.endsWith(".class")) classes.put(n.substring(0, n.length() - 6), data);
				else resources.put(n, data);
			}
		}
		System.out.println("[remap] " + classes.size() + " classes, " + resources.size() + " resources");

		// hierarchy of obfuscated classes
		Map<String, Hier> hier = new HashMap<>();
		for (Map.Entry<String, byte[]> e : classes.entrySet()) {
			ClassReader cr = new ClassReader(e.getValue());
			Hier h = new Hier();
			h.superName = cr.getSuperName();
			h.interfaces = cr.getInterfaces();
			hier.put(e.getKey(), h);
		}

		Remapper remapper = new Remapper() {
			@Override public String map(String internalName) {
				ProguardMappings.ClassEntry ce = m.byObf.get(internalName.replace('/', '.'));
				return ce != null ? ce.deobfInternal : internalName;
			}
			@Override public String mapFieldName(String owner, String name, String descriptor) {
				String r = resolveField(m, hier, owner, name);
				return r != null ? r : name;
			}
			@Override public String mapMethodName(String owner, String name, String descriptor) {
				if (name.equals("<init>") || name.equals("<clinit>")) return name;
				String r = resolveMethod(m, hier, owner, name + descriptor);
				return r != null ? r : name;
			}
			@Override public String mapRecordComponentName(String owner, String name, String descriptor) {
				String r = resolveField(m, hier, owner, name);
				return r != null ? r : name;
			}
			@Override public String mapInvokeDynamicMethodName(String name, String descriptor) {
				return name; // functional-interface method names are unmapped here
			}
		};

		Files.createDirectories(out.getParent());
		int written = 0;
		try (ZipOutputStream zos = new ZipOutputStream(Files.newOutputStream(out))) {
			for (Map.Entry<String, byte[]> e : classes.entrySet()) {
				ClassReader cr = new ClassReader(e.getValue());
				ClassWriter cw = new ClassWriter(0);
				cr.accept(new ClassRemapper(cw, remapper), 0);
				String newName = remapper.map(e.getKey());
				zos.putNextEntry(new ZipEntry(newName + ".class"));
				zos.write(cw.toByteArray());
				zos.closeEntry();
				written++;
			}
			for (Map.Entry<String, byte[]> e : resources.entrySet()) {
				zos.putNextEntry(new ZipEntry(e.getKey()));
				zos.write(e.getValue());
				zos.closeEntry();
			}
		}
		System.out.println("[remap] wrote " + written + " classes -> " + out);
	}

	private static String resolveField(ProguardMappings m, Map<String, Hier> hier, String owner, String name) {
		if (owner == null || owner.startsWith("[")) return null;
		ProguardMappings.ClassEntry ce = m.byObf.get(owner.replace('/', '.'));
		if (ce != null) {
			String r = ce.fields.get(name);
			if (r != null) return r;
		}
		Hier h = hier.get(owner);
		if (h == null) return null;
		if (h.superName != null) {
			String r = resolveField(m, hier, h.superName, name);
			if (r != null) return r;
		}
		if (h.interfaces != null) {
			for (String i : h.interfaces) {
				String r = resolveField(m, hier, i, name);
				if (r != null) return r;
			}
		}
		return null;
	}

	private static String resolveMethod(ProguardMappings m, Map<String, Hier> hier, String owner, String key) {
		if (owner == null || owner.startsWith("[")) return null;
		ProguardMappings.ClassEntry ce = m.byObf.get(owner.replace('/', '.'));
		if (ce != null) {
			String r = ce.methods.get(key);
			if (r != null) return r;
		}
		Hier h = hier.get(owner);
		if (h == null) return null;
		if (h.superName != null) {
			String r = resolveMethod(m, hier, h.superName, key);
			if (r != null) return r;
		}
		if (h.interfaces != null) {
			for (String i : h.interfaces) {
				String r = resolveMethod(m, hier, i, key);
				if (r != null) return r;
			}
		}
		return null;
	}

	static byte[] readAll(InputStream in) throws IOException {
		ByteArrayOutputStream bos = new ByteArrayOutputStream(Math.max(64, in.available()));
		byte[] buf = new byte[16384];
		int n;
		while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
		in.close();
		return bos.toByteArray();
	}

	static List<String> nothing() { return new ArrayList<>(); }
}
