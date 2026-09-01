package mcextract;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Parser for Mojang's ProGuard-format client mappings (client.txt).
 *
 * Format:
 *   net.minecraft.client.model.ChickenModel -> fuz:
 *   # {"fileName":...}
 *       org.joml.Vector3f origin -> b
 *       12:34:void foo(int,java.lang.String) -> a
 *
 * The left hand side is the DEOBFUSCATED (official / "Mojang mapped") name, the
 * right hand side is the OBFUSCATED name found in the shipped client jar.
 */
public final class ProguardMappings {

	public static final class ClassEntry {
		public final String deobf;      // net.minecraft.client.model.ChickenModel
		public final String obf;        // fuz
		public final String deobfInternal; // net/minecraft/client/model/ChickenModel
		public final String obfInternal;   // fuz
		/** obfName -> deobfName */
		public final Map<String, String> fields = new HashMap<>();
		/** obfName + obfDesc -> deobfName */
		public final Map<String, String> methods = new HashMap<>();

		ClassEntry(String deobf, String obf) {
			this.deobf = deobf;
			this.obf = obf;
			this.deobfInternal = deobf.replace('.', '/');
			this.obfInternal = obf.replace('.', '/');
		}
	}

	/** obf binary name -> entry */
	public final Map<String, ClassEntry> byObf = new HashMap<>();
	/** deobf binary name -> entry */
	public final Map<String, ClassEntry> byDeobf = new HashMap<>();

	public static ProguardMappings load(Path file) throws IOException {
		ProguardMappings m = new ProguardMappings();
		List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);

		// -- pass 1: class names only (needed to translate descriptors in pass 2) --
		for (String line : lines) {
			if (line.isEmpty() || line.charAt(0) == '#' || line.charAt(0) == ' ' || line.charAt(0) == '\t') continue;
			int arrow = line.indexOf(" -> ");
			if (arrow < 0) continue;
			String deobf = line.substring(0, arrow).trim();
			String obf = line.substring(arrow + 4).trim();
			if (obf.endsWith(":")) obf = obf.substring(0, obf.length() - 1);
			ClassEntry e = new ClassEntry(deobf, obf);
			m.byObf.put(obf, e);
			m.byDeobf.put(deobf, e);
		}

		// -- pass 2: members --
		ClassEntry cur = null;
		for (String line : lines) {
			if (line.isEmpty() || line.charAt(0) == '#') continue;
			boolean indented = line.charAt(0) == ' ' || line.charAt(0) == '\t';
			int arrow = line.indexOf(" -> ");
			if (arrow < 0) continue;
			if (!indented) {
				String deobf = line.substring(0, arrow).trim();
				cur = m.byDeobf.get(deobf);
				continue;
			}
			if (cur == null) continue;
			String lhs = line.substring(0, arrow).trim();
			String obfName = line.substring(arrow + 4).trim();

			// strip "12:34:" line-number prefix
			int c1 = lhs.indexOf(':');
			if (c1 > 0 && isDigits(lhs, 0, c1)) {
				int c2 = lhs.indexOf(':', c1 + 1);
				if (c2 > 0) lhs = lhs.substring(c2 + 1);
			}

			int paren = lhs.indexOf('(');
			if (paren < 0) {
				// field:  "<type> <name>"
				int sp = lhs.lastIndexOf(' ');
				if (sp < 0) continue;
				String name = lhs.substring(sp + 1);
				cur.fields.put(obfName, name);
			} else {
				// method: "<retType> <name>(<argTypes>)"
				String head = lhs.substring(0, paren);
				int sp = head.lastIndexOf(' ');
				if (sp < 0) continue;
				String ret = head.substring(0, sp).trim();
				String name = head.substring(sp + 1).trim();
				String args = lhs.substring(paren + 1, lhs.lastIndexOf(')'));
				String desc = m.buildObfDescriptor(args, ret);
				cur.methods.put(obfName + desc, name);
			}
		}
		return m;
	}

	private static boolean isDigits(String s, int from, int to) {
		if (to <= from) return false;
		for (int i = from; i < to; i++) if (!Character.isDigit(s.charAt(i))) return false;
		return true;
	}

	/** Builds the OBFUSCATED JVM descriptor from deobfuscated java type names. */
	public String buildObfDescriptor(String argList, String returnType) {
		StringBuilder sb = new StringBuilder("(");
		if (!argList.isEmpty()) {
			for (String a : argList.split(",")) sb.append(typeToObfDesc(a.trim()));
		}
		sb.append(')').append(typeToObfDesc(returnType.trim()));
		return sb.toString();
	}

	public String typeToObfDesc(String type) {
		int arr = 0;
		while (type.endsWith("[]")) {
			arr++;
			type = type.substring(0, type.length() - 2);
		}
		String base;
		switch (type) {
			case "void":    base = "V"; break;
			case "boolean": base = "Z"; break;
			case "byte":    base = "B"; break;
			case "char":    base = "C"; break;
			case "short":   base = "S"; break;
			case "int":     base = "I"; break;
			case "long":    base = "J"; break;
			case "float":   base = "F"; break;
			case "double":  base = "D"; break;
			default: {
				ClassEntry e = byDeobf.get(type);
				String bin = e != null ? e.obf : type;
				base = "L" + bin.replace('.', '/') + ";";
			}
		}
		StringBuilder sb = new StringBuilder();
		for (int i = 0; i < arr; i++) sb.append('[');
		return sb.append(base).toString();
	}

	public List<String> allObfInternalNames() {
		List<String> out = new ArrayList<>(byObf.size());
		for (ClassEntry e : byObf.values()) out.add(e.obfInternal);
		return out;
	}
}
